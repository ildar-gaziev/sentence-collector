const out = document.getElementById('out')
const copyBtn = document.getElementById('copy')
const clearBtn = document.getElementById('clear')

const storage =
  (chrome.storage && chrome.storage.session) ||
  (chrome.storage && chrome.storage.local) ||
  null

// 1) Пробуем прочитать из storage
;(async () => {
  try {
    if (storage) {
      const data = await storage.get({ lastSentence: '' })
      if (data.lastSentence && !out.value) out.value = data.lastSentence
    }
  } catch (e) {
    console.warn('storage.get failed:', e)
  }
})()

// 2) Запрашиваем у background (на случай, если сообщение пришло до инициализации)
;(async () => {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'REQUEST_LAST_SENTENCE'
    })
    if (resp?.lastSentence && !out.value) {
      out.value = resp.lastSentence
      storage?.set?.({ lastSentence: resp.lastSentence }).catch(() => {})
    }
  } catch (e) {
    // если фон недоступен — не критично
  }
})()

// 3) Живые сообщения (если фон отправит после открытия панели)
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'SIDE_PANEL_TEXT') {
    out.value = msg.payload || ''
    storage?.set?.({ lastSentence: out.value }).catch(() => {})
  }
})

chrome.runtime.onMessage.addListener(m => console.log('SIDE_PANEL_TEXT:', m))


