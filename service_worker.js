import { getSentenceFromAnyFrame } from './sentenceSelection.js'
import { highlightSentenceInFrames } from './sentenceHighlight.js'

// service_worker.js (MV3, module)
const storage =
  (chrome.storage && chrome.storage.session) ||
  (chrome.storage && chrome.storage.local) ||
  null

let lastSentence = ''

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'copy-sentence-to-sidepanel',
    title: 'Copy sentence to my collection',
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'REQUEST_LAST_SENTENCE') {
    sendResponse({ lastSentence })
    return true
  }
})

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(error => console.error(error))
