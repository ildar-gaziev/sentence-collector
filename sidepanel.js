const out = document.getElementById('out')
const copyBtn = document.getElementById('copy')
const clearBtn = document.getElementById('clear')

const storage =
  (chrome.storage && chrome.storage.session) ||
  (chrome.storage && chrome.storage.local) ||
  null

const getSentence = () => out.textContent || ''
const setSentence = text => {
  out.textContent = text || ''
}

const persistSentence = text =>
  storage?.set?.({ lastSentence: text ?? '' }).catch(() => {})

// tyr to read from storage
;(async () => {
  try {
    if (storage) {
      const data = await storage.get({ lastSentence: '' })
      if (data.lastSentence && !getSentence()) setSentence(data.lastSentence)
    }
  } catch (e) {
    console.warn('storage.get failed:', e)
  }
})()
;(async () => {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'REQUEST_LAST_SENTENCE'
    })
    if (resp?.lastSentence && !getSentence()) {
      setSentence(resp.lastSentence)
      persistSentence(resp.lastSentence)
    }
  } catch (e) {
    /* ignore */
  }
})()

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'SIDE_PANEL_TEXT') {
    setSentence(msg.payload || '')
    persistSentence(getSentence())
  }
})

copyBtn?.addEventListener('click', async () => {
  const text = getSentence()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch (e) {
    console.warn('clipboard write failed:', e)
  }
})

clearBtn?.addEventListener('click', () => {
  setSentence('')
  persistSentence('')
})
