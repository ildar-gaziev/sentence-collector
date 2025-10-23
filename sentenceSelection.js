export async function getSentenceFromAnyFrame (tabId, hintedFrameId) {
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

  const ordered = [
    ...frames.filter(f => f.frameId === hintedFrameId),
    ...frames.filter(f => f.frameId !== hintedFrameId)
  ]

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

  for (const f of ordered) {
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        func: inlineExtractSentence
      })
      if ((result || '').trim()) return result.trim()
    } catch (e) {}
  }

  return ''
}

export function inlineExtractSentence () {
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
