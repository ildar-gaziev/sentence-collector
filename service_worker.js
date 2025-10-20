// service_worker.js (MV3, module)
const storage =
  (chrome.storage && chrome.storage.session) ||
  (chrome.storage && chrome.storage.local) ||
  null

let lastSentence = ''

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'copy-sentence-to-sidepanel',
    title: 'Скопировать предложение в боковую панель',
    contexts: ['selection', 'page']
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'copy-sentence-to-sidepanel' || !tab?.id) return

  // 1) СРАЗУ открыть боковую панель — без await!
  chrome.sidePanel
    .setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true })
    .then(() => chrome.sidePanel.open({ tabId: tab.id }))
    .catch(e => console.warn('sidePanel API error:', e))

  // 2) Остальное — асинхронно, уже без требования user gesture
  ;(async () => {
    // не трогаем системные страницы
    const url = tab.url || ''
    if (
      /^(chrome|edge|about|view-source):/i.test(url) ||
      /chrome\.google\.com\/webstore/i.test(url)
    ) {
      console.warn('Нельзя работать на этой странице:', url)
      return
    }

    // получаем предложение из любого фрейма (ваша реализация)
    const text = (await getSentenceFromAnyFrame(tab.id, info.frameId)).trim()
    if (!text) return

    // кэшируем и отправляем в панель
    try {
      await (chrome.storage.session ?? chrome.storage.local)?.set?.({
        lastSentence: text
      })
    } catch {}
    chrome.runtime.sendMessage(
      { type: 'SIDE_PANEL_TEXT', payload: text },
      () => {
        void chrome.runtime.lastError
      }
    )
    highlightSentenceInFrames(tab.id, info.frameId).catch(() => {})
  })()
})

// --- helper с учётом frameId и fallback через executeScript ---
async function getSentenceFromAnyFrame (tabId, hintedFrameId) {
  // 1) получаем все фреймы вкладки
  let frames = []
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId })
  } catch (e) {
    console.warn('getAllFrames failed:', e)
    frames = [
      { frameId: typeof hintedFrameId === 'number' ? hintedFrameId : 0 }
    ]
  }

  // ставим подсказанный frameId первым в очереди
  const ordered = [
    ...frames.filter(f => f.frameId === hintedFrameId),
    ...frames.filter(f => f.frameId !== hintedFrameId)
  ]

  // 2) пробуем отправить сообщение в каждый фрейм — берём первый валидный ответ
  for (const f of ordered) {
    const sentence = await new Promise(resolve => {
      let done = false
      chrome.tabs.sendMessage(
        tabId,
        { type: 'GET_SENTENCE' },
        { frameId: f.frameId },
        resp => {
          if (chrome.runtime.lastError) {
            console.warn(
              'Error sending message:',
              chrome.runtime.lastError.message
            )
          }
          if (!done) {
            done = true
            resolve(resp?.sentence || '')
          }
        }
      )
      setTimeout(() => {
        if (!done) {
          done = true
          resolve('')
        }
      }, 400)
    })
    if (sentence) return sentence
  }

  // 3) fallback: исполняем функцию прямо в фреймах (без content.js)
  for (const f of ordered) {
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        func: inlineExtractSentence // см. ниже — та же функция, что была у тебя
      })
      if ((result || '').trim()) return result.trim()
    } catch (e) {
      // некоторые фреймы могут быть закрыты политиками/СSP — это ожидаемо
    }
  }

  return ''
}

// Внимание: эта функция будет исполнена в изолированном мире целевого фрейма
function inlineExtractSentence () {
  // пытаемся использовать текущее выделение, если пусто — позицию последнего клика восстановить нельзя,
  // поэтому берём каретку из selection (если она есть)
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return ''

  const range = sel.getRangeAt(0).cloneRange()
  // приводим к текст-узлу
  function normalize (r) {
    const rr = r.cloneRange()
    if (rr.startContainer.nodeType === Node.ELEMENT_NODE) {
      const t = (function closestText (node, offset) {
        if (node.nodeType === Node.TEXT_NODE) return node
        const child =
          node.childNodes[offset] ||
          node.childNodes[offset - 1] ||
          node.firstChild
        const stack = [child || node]
        while (stack.length) {
          const n = stack.shift()
          if (!n) break
          if (n.nodeType === Node.TEXT_NODE) return n
          for (const c of n.childNodes) stack.push(c)
        }
        return null
      })(rr.startContainer, rr.startOffset)
      if (!t) return null
      const nr = document.createRange()
      nr.setStart(t, Math.min(rr.startOffset, t.textContent.length))
      nr.collapse(true)
      return nr
    }
    return rr
  }
  const nr = normalize(range)
  if (!nr) return ''

  // собираем текст всего блочного контейнера
  function getBlock (elOrNode) {
    let el =
      elOrNode.nodeType === Node.ELEMENT_NODE
        ? elOrNode
        : elOrNode.parentElement
    while (el && getComputedStyle(el).display === 'inline')
      el = el.parentElement
    return el || document.body
  }
  function buildBlockText (anchorNode) {
    const block = getBlock(anchorNode)
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: t =>
        t.nodeValue && t.nodeValue.trim().length
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT
    })
    let buf = '',
      infos = [],
      idx = 0
    while (walker.nextNode()) {
      const t = walker.currentNode
      const start = idx
      buf += t.nodeValue
      idx += t.nodeValue.length
      infos.push({ node: t, start, end: idx })
    }
    const toTextOffset = (node, off) => {
      const i = infos.find(x => x.node === node)
      return i ? i.start + off : 0
    }
    return { text: buf, toTextOffset }
  }

  const { text, toTextOffset } = buildBlockText(nr.startContainer)
  if (!text) return ''

  const caret = toTextOffset(nr.startContainer, nr.startOffset)
  const SEP = /[.!?;…]/
  const QUOTE_R = /[)"»›’”\]]/

  let s = caret
  while (s > 0) {
    const ch = text[s - 1]
    if (ch === '\n' || SEP.test(ch)) break
    s--
  }
  while (s < caret && /\s/.test(text[s])) s++

  let e = caret
  while (e < text.length) {
    const ch = text[e]
    if (ch === '\n') break
    if (SEP.test(ch)) {
      let t = e + 1
      while (t < text.length && QUOTE_R.test(text[t])) t++
      e = t
      break
    }
    e++
  }
  if (e === caret || e >= text.length) e = text.length

  while (s < e && /\s/.test(text[s])) s++
  while (e > s && /\s/.test(text[e - 1])) e--

  return text.slice(s, e).trim()
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'REQUEST_LAST_SENTENCE') {
    sendResponse({ lastSentence })
    return true
  }
})

async function highlightSentenceInFrames (tabId, hintedFrameId) {
  // 1) пробуем отправить команду контент-скрипту в «подсказанный» фрейм
  const trySend = frameId =>
    new Promise(resolve => {
      let settled = false
      const finish = value => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      chrome.tabs.sendMessage(
        tabId,
        { type: 'HIGHLIGHT_SENTENCE' },
        { frameId },
        resp => {
          if (chrome.runtime.lastError) {
            // Receiving end does not exist — нормально, пробуем дальше
            console.debug(
              'highlightSentenceInFrames sendMessage error:',
              chrome.runtime.lastError.message
            )
            finish(false)
            return
          }
          // Receiving end does not exist — нормально, пробуем дальше
          finish(Boolean(resp?.ok))
        }
      )
      setTimeout(() => finish(false), 300)
    })

  // 2) соберём список фреймов (подсказанный — первым)
  let frames = []
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId })
  } catch {
    frames = [
      { frameId: typeof hintedFrameId === 'number' ? hintedFrameId : 0 }
    ]
  }
  const ordered = [
    ...frames.filter(f => f.frameId === hintedFrameId),
    ...frames.filter(f => f.frameId !== hintedFrameId)
  ]

  // 3) пробуем по очереди через message
  for (const f of ordered) {
    if (await trySend(f.frameId)) return true
  }

  // 4) fallback: инлайновая подсветка через executeScript
  for (const f of ordered) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        func: inlineHighlightCurrentSentence
      })
      return true
    } catch {
      // может быть закрыто CSP — пробуем следующий
    }
  }
  return false
}

// будет исполнена внутри страницы, создаёт краткую подсветку того же предложения
function inlineHighlightCurrentSentence () {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return

  const range = sel.getRangeAt(0).cloneRange()

  function normalize (r) {
    const rr = r.cloneRange()
    if (rr.startContainer.nodeType === Node.ELEMENT_NODE) {
      const t = (function findText (node, offset) {
        if (node.nodeType === Node.TEXT_NODE) return node
        const child =
          node.childNodes[offset] ||
          node.childNodes[offset - 1] ||
          node.firstChild
        const stack = [child || node]
        while (stack.length) {
          const n = stack.shift()
          if (!n) break
          if (n.nodeType === Node.TEXT_NODE) return n
          for (const c of n.childNodes) stack.push(c)
        }
        return null
      })(rr.startContainer, rr.startOffset)
      if (!t) return null
      const nr = document.createRange()
      nr.setStart(t, Math.min(rr.startOffset, t.textContent.length))
      nr.collapse(true)
      return nr
    }
    return rr
  }

  const nr = normalize(range)
  if (!nr) return

  function getBlock (n) {
    let el = n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement
    while (el && getComputedStyle(el).display === 'inline')
      el = el.parentElement
    return el || document.body
  }

  function build (blockNode) {
    const block = getBlock(blockNode)
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: t =>
        t.nodeValue && t.nodeValue.trim().length
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT
    })
    let buf = '',
      infos = [],
      idx = 0
    while (walker.nextNode()) {
      const t = walker.currentNode
      const start = idx
      buf += t.nodeValue
      idx += t.nodeValue.length
      infos.push({ node: t, start, end: idx })
    }
    const toTextOffset = (node, off) => {
      const i = infos.find(x => x.node === node)
      return i ? i.start + off : 0
    }
    const fromTextOffset = off => {
      for (const i of infos)
        if (off >= i.start && off <= i.end)
          return { node: i.node, offset: off - i.start }
      const last = infos[infos.length - 1]
      return { node: last.node, offset: last.node.nodeValue.length }
    }
    return { text: buf, toTextOffset, fromTextOffset }
  }

  const { text, toTextOffset, fromTextOffset } = build(nr.startContainer)
  if (!text) return

  const caret = toTextOffset(nr.startContainer, nr.startOffset)
  const SEP = /[.!?;…]/,
    QR = /[)"»›’”\]]/

  let s = caret
  while (s > 0) {
    const ch = text[s - 1]
    if (ch === '\n' || SEP.test(ch)) break
    s--
  }
  while (s < caret && /\s/.test(text[s])) s++

  let e = caret
  while (e < text.length) {
    const ch = text[e]
    if (ch === '\n') break
    if (SEP.test(ch)) {
      let t = e + 1
      while (t < text.length && QR.test(text[t])) t++
      e = t
      break
    }
    e++
  }
  if (e === caret || e >= text.length) e = text.length
  while (s < e && /\s/.test(text[s])) s++
  while (e > s && /\s/.test(text[e - 1])) e--

  const sPos = fromTextOffset(s),
    ePos = fromTextOffset(e)
  const r = document.createRange()
  r.setStart(sPos.node, sPos.offset)
  r.setEnd(ePos.node, ePos.offset)

  const mark = document.createElement('span')
  mark.style.background = 'rgba(255,230,150,0.8)'
  mark.style.transition = 'background 3000ms ease'
  mark.className = 'sentence-highlight-marker' // на случай кастомизации
  r.surroundContents(mark)
  setTimeout(() => (mark.style.background = 'transparent'), 50)
  setTimeout(() => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
  }, 3000)
}

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(error => console.error(error))
