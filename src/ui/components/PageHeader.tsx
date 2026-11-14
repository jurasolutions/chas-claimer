import type { ReactNode } from "react";

interface PageHeaderProps {
  /** The page's one heading, in sentence case. */
  title: ReactNode;
  /** A sentence under the title (Today's sentence of counts). */
  lede?: ReactNode;
  /** The screen's actions; at most one of them is primary (docs/design.md, Principles). */
  actions?: ReactNode;
}

/** The top of every page: the heading on the left, the actions on the right. */
export function PageHeader({ title, lede, actions }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div className="page-header__text">
        <h1>{title}</h1>
        {lede ? <p className="page-header__lede">{lede}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </div>
  );
}
