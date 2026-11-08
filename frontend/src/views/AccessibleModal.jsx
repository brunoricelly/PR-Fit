import React from 'react'
import Modal from '../components/Modal.jsx'
import { professionalText as p } from '../lib/professional-copy.js'

export default function AccessibleModal({ id, title, onClose, children, className = '' }) {
  return (
    <Modal id={id} title={title} onClose={onClose} closeLabel={p('Close')} className={`pro-modal-container ${className}`}>
      {children}
    </Modal>
  )
}
