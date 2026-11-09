import Icon from './Icon.jsx'

// An empty list's place (redesign 1.4.5, P9): the sentence and the first action together, centred
// where the list will appear, in a quiet frame the size of a first row or two. Before, the history's
// "Log a past workout" sat above its empty message and the message floated in a screen of black.
// `children` are the actions (Buttons); the first one is the way in.
export default function EmptyState({ icon, title, text, description, action, children, className = '', tour, designSystem = false }) {
  const body = text ?? description
  const actions = action ?? children
  const stateClass = designSystem ? ' ds-state' : ''
  return <div className={'empty empty-state' + stateClass + (className ? ' ' + className : '')} data-tour={tour}>
    {icon && <div className={'ico' + (designSystem ? ' ds-state-icon' : '')}><Icon name={icon} /></div>}
    {title && <h2 className={'empty-t' + (designSystem ? ' ds-state-title' : '')}>{title}</h2>}
    {body && <div className={'empty-x' + (designSystem ? ' ds-state-text' : '')}>{body}</div>}
    {actions && <div className={'empty-acts' + (designSystem ? ' ds-state-actions' : '')}>{actions}</div>}
  </div>
}
