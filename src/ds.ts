/**
 * The one import point for the design system. Every screen renders from here: no ad-hoc
 * components, no second icon or font set.
 *
 * `src/design-system/` is a read-only copy of `jurasolutions/design-system/`. Change it at source,
 * then run `npm run sync:ds`. Imports are extensionless so TypeScript reads each component's
 * `.d.ts` and Vite bundles the `.jsx` beside it. The marketing motion components are left out:
 * the desk animates only in answer to an action.
 */
export { Logo } from "./design-system/components/brand/Logo";
export { Icon } from "./design-system/components/brand/Icon";

export { Button } from "./design-system/components/core/Button";
export { IconButton } from "./design-system/components/core/IconButton";
export { Card } from "./design-system/components/core/Card";
export { Badge } from "./design-system/components/core/Badge";
export { Tag } from "./design-system/components/core/Tag";

export { Field } from "./design-system/components/forms/Field";
export { Input, Textarea } from "./design-system/components/forms/Input";
export { Select } from "./design-system/components/forms/Select";
export { Checkbox, Radio, Switch } from "./design-system/components/forms/Choice";

export { Alert } from "./design-system/components/feedback/Alert";
// The design system's Dialog, with the focus handling a modal needs (QA D06). See `./dialog`.
export { Dialog } from "./dialog";
export { Toast } from "./design-system/components/feedback/Toast";
export { Tooltip } from "./design-system/components/feedback/Tooltip";

export { Accordion } from "./design-system/components/navigation/Accordion";
export { Tabs } from "./design-system/components/navigation/Tabs";

export type { BadgeProps } from "./design-system/components/core/Badge";
export type { ButtonProps } from "./design-system/components/core/Button";
