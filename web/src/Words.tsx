/** Words fade up one after another (skipped for long text so it never drags). */
export function Words({ text, step = 26 }: { text: string; step?: number }) {
  const words = text.split(/(\s+)/);
  if (words.length > 160) return <>{text}</>;
  let i = 0;
  return (
    <>
      {words.map((w, k) =>
        /^\s+$/.test(w) ? w : <span className="w" key={k} style={{ animationDelay: `${i++ * step}ms` }}>{w}</span>,
      )}
    </>
  );
}
