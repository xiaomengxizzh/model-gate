import { h, button } from './index.js'

export function openModal({ title, body, footer, onClose, canClose = () => true, width = '620px' }) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const titleNode = h('h2', { id: 'dialog-title', text: title })
  const bodyNode = h('div', { class: 'dialog-body' }, body)
  const errorNode = h('div', { class: 'dialog-error', role: 'alert', 'aria-atomic': 'true', tabindex: '-1', hidden: true })
  const footerNode = h('footer', { class: 'dialog-footer' }, footer || button('关闭', () => close()))
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'dialog-title', 'aria-modal': 'true', tabindex: '-1', style: { width: 'min(' + width + ', calc(100vw - 24px))' } },
    h('header', { class: 'dialog-header' }, titleNode, h('button', { type: 'button', class: 'icon-button dialog-close', 'aria-label': '关闭弹窗', text: '×', onClick: () => { if (canClose()) close() } })),
    bodyNode,
    errorNode,
    footerNode,
  )
  let closed = false
  let busy = false
  let resumeFocus = null
  const focusable = () => [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter((node) => !node.hidden && node.getClientRects().length)
  const focusFallback = () => {
    if (!dialog.open || busy) return
    if (!errorNode.hidden) errorNode.focus({ preventScroll: true })
    else (dialog.querySelector('input:not(:disabled), select:not(:disabled), button:not(:disabled):not(.dialog-close)') || focusable()[0] || dialog).focus({ preventScroll: true })
  }
  const close = () => {
    if (closed || busy || !canClose()) return
    closed = true
    document.removeEventListener('keydown', onKeydown, true)
    dialog.close()
  }
  const onKeydown = (event) => {
    if (!dialog.open || event.key !== 'Escape') return
    // Chrome's Escape close request is not always cancelable. Handle the key
    // before the browser emits cancel so a busy transaction cannot be abandoned.
    event.preventDefault()
    event.stopPropagation()
    if (busy) dialog.focus({ preventScroll: true })
    else close()
  }
  document.addEventListener('keydown', onKeydown, true)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    if (event.cancelable) close()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog || !canClose()) return
    const rect = dialog.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close()
  })
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return
    const items = focusable()
    if (!items.length) { event.preventDefault(); return }
    const first = items[0]
    const last = items.at(-1)
    if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first).focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  })
  dialog.addEventListener('close', () => {
    closed = true
    resumeFocus = null
    document.removeEventListener('keydown', onKeydown, true)
    if (opener && opener.isConnected) opener.focus()
    dialog.remove()
    if (onClose) onClose()
  })
  document.body.append(dialog)
  dialog.showModal()
  requestAnimationFrame(() => { if (dialog.open) focusFallback() })
  return {
    dialog,
    close,
    setBody(...content) { bodyNode.replaceChildren(...content); focusFallback() },
    setFooter(...content) { footerNode.replaceChildren(...content); focusFallback() },
    setError(message) {
      errorNode.hidden = !message
      errorNode.textContent = message || ''
      if (message) focusFallback()
    },
    setBusy(value) {
      busy = !!value
      dialog.setAttribute('aria-busy', busy ? 'true' : 'false')
      if (busy) resumeFocus = dialog.contains(document.activeElement) ? document.activeElement : resumeFocus
      for (const node of dialog.querySelectorAll('button, input, select, textarea')) node.disabled = busy
      if (busy) dialog.focus({ preventScroll: true })
      else if (!errorNode.hidden) errorNode.focus({ preventScroll: true })
      else if (resumeFocus?.isConnected && !resumeFocus.disabled && dialog.contains(resumeFocus)) resumeFocus.focus({ preventScroll: true })
      else focusFallback()
    },
  }
}

export function field(label, input, hint = '') {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input, hint ? h('small', { class: 'field-hint', text: hint }) : null)
}
