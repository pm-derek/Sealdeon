// One header pattern for every page: a title, the question the page answers
// in one line, and the method behind a "How to read this" disclosure -- so
// explanations are one tap away instead of a wall of text above the data.
export default function PageHeader({ title, question, children, right }) {
  return (
    <div className="pt-1 pb-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold">{title}</h2>
        {right}
      </div>
      {question && <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>{question}</p>}
      {children && (
        <details className="mt-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <summary className="cursor-pointer select-none" style={{ color: 'var(--accent)' }}>How to read this</summary>
          <div className="mt-2 space-y-1.5 max-w-3xl leading-relaxed">{children}</div>
        </details>
      )}
    </div>
  )
}
