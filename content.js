/**
 * Расширяет текущее выделение/каретку до границ предложения и возвращает текст.
 * Границы предложения: от ближайшего разделителя слева до ближайшего справа.
 * Разделители: . ! ? … ; и их сочетания, плюс переводы строк/конец блока.
 * Сохраняем максимально простую и надежную логику по DOM.
 */

;(function init () {
  // Храним последнюю точку правого клика (на случай клика без выделения)
  let lastRightClickRange = null

  document.addEventListener('contextmenu', e => {
    // Попытка получить каретку в точке клика
    const range = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(e.clientX, e.clientY)
      : (function () {
          // Современный fallback
          if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(e.clientX, e.clientY)
            if (pos && pos.offsetNode) {
              const r = document.createRange()
              r.setStart(pos.offsetNode, pos.offset)
              r.collapse(true)
              return r
            }
          }
          return null
        })()

    if (range) lastRightClickRange = range
  })

  // Главная функция: расширить до предложения
  function expandSelectionToSentence () {
    const sel = window.getSelection()
    let range = null

    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      range = sel.getRangeAt(0).cloneRange()
    } else if (sel && sel.rangeCount > 0) {
      range = sel.getRangeAt(0).cloneRange()
    } else if (lastRightClickRange) {
      range = lastRightClickRange.cloneRange()
    } else {
      return ''
    }

    // Стремимся работать внутри текстового узла
    range = normalizeRangeToTextNode(range)
    if (!range) return ''

    const node = range.startContainer
    const offset = range.startOffset

    // Получаем весь текстовый буфер текущего блочного контейнера
    const { blockText, toTextOffset, fromTextOffset, textNodeInfo } =
      getBlockTextAndMapping(node)

    if (!blockText) return ''

    // Находим границы предложения в плоском тексте
    const caretIdx = toTextOffset(node, offset)
    const [startIdx, endIdx] = findSentenceBounds(blockText, caretIdx)

    const sentence = blockText.slice(startIdx, endIdx).trim()

    // Для визуальщины (опционально): подсветим предложение на странице ненадолго
    try {
      const domRange = textOffsetsToDomRange(
        textNodeInfo,
        startIdx,
        endIdx,
        fromTextOffset
      )
      flashRange(domRange)
    } catch {
      /* no-op */
    }

    return sentence
  }

  // Утилиты

  function normalizeRangeToTextNode (r) {
    const range = r.cloneRange()
    if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
      // Переводим в текстовый узел, если возможно
      const tn = closestTextNode(range.startContainer, range.startOffset)
      if (!tn) return null
      const off = Math.min(range.startOffset, tn.textContent.length)
      const nr = document.createRange()
      nr.setStart(tn, off)
      nr.collapse(true)
      return nr
    }
    return range
  }

  function closestTextNode (elOrNode, offset) {
    let node = elOrNode
    if (node.nodeType === Node.TEXT_NODE) return node
    // Ищем текстовый узел справа от offset, затем слева
    const child = node.childNodes[offset] || node.childNodes[offset - 1]
    if (!child) {
      // Попробуем спуститься вглубь
      return deepFirstTextNode(node)
    }
    return child.nodeType === Node.TEXT_NODE ? child : deepFirstTextNode(child)
  }

  function deepFirstTextNode (n) {
    if (n.nodeType === Node.TEXT_NODE) return n
    for (const c of n.childNodes) {
      const t = deepFirstTextNode(c)
      if (t) return t
    }
    return null
  }

  function getBlockAncestor (n) {
    // Поднимаемся до блочного контейнера (p, div, li, td, etc.)
    let el = n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement
    while (el && getComputedStyle(el).display === 'inline') {
      el = el.parentElement
    }
    return el || document.body
  }

  function getBlockTextAndMapping (anchorTextNode) {
    const block = getBlockAncestor(anchorTextNode)
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: t =>
        t.nodeValue && t.nodeValue.trim().length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT
    })

    let blockText = ''
    const textNodeInfo = []
    let idx = 0

    while (walker.nextNode()) {
      const t = walker.currentNode
      const start = idx
      const text = t.nodeValue
      blockText += text
      idx += text.length
      const end = idx
      textNodeInfo.push({ node: t, start, end })
    }

    function toTextOffset (node, nodeOffset) {
      const info = textNodeInfo.find(i => i.node === node)
      if (!info) return 0
      return info.start + nodeOffset
    }

    function fromTextOffset (textOffset) {
      // Возвращает { node, offset } для плоского индекса
      for (const info of textNodeInfo) {
        if (textOffset >= info.start && textOffset <= info.end) {
          return { node: info.node, offset: textOffset - info.start }
        }
      }
      // Если вышли за пределы — щадяще прижмем к концу
      const last = textNodeInfo[textNodeInfo.length - 1]
      return { node: last.node, offset: last.node.nodeValue.length }
    }

    return { blockText, toTextOffset, fromTextOffset, textNodeInfo }
  }

  function findSentenceBounds (text, caretIdx) {
    // Разделители предложений: . ! ? … ; (и их повторы), а также новая строка
    // Включаем закрывающие кавычки/скобки справа.
    const SEP = /[.!?;…]/
    const QUOTE_RIGHT = /[)"»›»’”\]]/

    // Ищем влево до ближайшего разделителя или начала строки/блока
    let start = caretIdx
    while (start > 0) {
      const ch = text[start - 1]
      if (ch === '\n') break
      if (SEP.test(ch)) break
      start--
    }
    // Пропускаем пробелы/переносы после разделителя
    while (start < caretIdx && /\s/.test(text[start])) start++

    // Ищем вправо до ближайшего разделителя или конца строки/блока
    let end = caretIdx
    while (end < text.length) {
      const ch = text[end]
      if (ch === '\n') break
      if (SEP.test(ch)) {
        // захватываем хвостовые кавычки/скобки
        let e = end + 1
        while (e < text.length && QUOTE_RIGHT.test(text[e])) e++
        end = e
        break
      }
      end++
    }
    // Если разделителя не нашли — до конца блока
    if (end === caretIdx || end >= text.length) end = text.length

    // Уберем ведущие/замыкающие пробелы
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--

    return [start, end]
  }

  function textOffsetsToDomRange (
    textNodeInfo,
    startIdx,
    endIdx,
    fromTextOffset
  ) {
    const { node: sNode, offset: sOff } = fromTextOffset(startIdx)
    const { node: eNode, offset: eOff } = fromTextOffset(endIdx)

    const r = document.createRange()
    r.setStart(sNode, sOff)
    r.setEnd(eNode, eOff)
    return r
  }

  function flashRange (r) {
    const mark = document.createElement('span')
    mark.style.background = 'rgba(255, 230, 150, 0.8)'
    mark.style.transition = 'background 600ms ease'
    r.surroundContents(mark)
    setTimeout(() => (mark.style.background = 'transparent'), 50)
    setTimeout(() => {
      // Распакуем назад, чтобы не ломать DOM
      const parent = mark.parentNode
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
      parent.removeChild(mark)
    }, 650)
  }
  function highlightCurrentSentence () {
    // почти та же логика, что в expand, только возвращает и подсвечивает Range
    const sel = window.getSelection()
    let range = null

    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      range = sel.getRangeAt(0).cloneRange()
    } else if (sel && sel.rangeCount > 0) {
      range = sel.getRangeAt(0).cloneRange()
    } else if (window.lastRightClickRange) {
      range = window.lastRightClickRange.cloneRange()
    } else {
      return
    }

    range = normalizeRangeToTextNode(range)
    if (!range) return

    const node = range.startContainer
    const offset = range.startOffset
    const { blockText, toTextOffset, fromTextOffset, textNodeInfo } =
      getBlockTextAndMapping(node)
    if (!blockText) return

    const caretIdx = toTextOffset(node, offset)
    const [startIdx, endIdx] = findSentenceBounds(blockText, caretIdx)
    const domRange = textOffsetsToDomRange(
      textNodeInfo,
      startIdx,
      endIdx,
      fromTextOffset
    )
    flashRange(domRange) // ← краткая подсветка
  }

  // Экспортируем в глобал — чтобы service worker мог выполнить через executeScript
  window.__expandSelectionToSentence = expandSelectionToSentence

  // Также слушаем команды от фона (если решите вызывать напрямую)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'GET_SENTENCE') {
      try {
        sendResponse({ sentence: expandSelectionToSentence() })
      } catch {
        sendResponse({ sentence: '' })
      }
      return true
    }
    if (msg?.type === 'SIDE_PANEL_TEXT') {
      // Проксируем в side panel (если она работает в том же процессе)
      chrome.runtime.sendMessage(msg)
    }
    if (msg?.type === 'HIGHLIGHT_SENTENCE') {
      try {
        // Переиспользуем ту же функцию, но просим отдать ещё и DOM-диапазон
        highlightCurrentSentence()
        sendResponse({ ok: true })
      } catch {
        sendResponse({ ok: false })
      }
      return true
    }
  })
})()
