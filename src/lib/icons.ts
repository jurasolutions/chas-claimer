/**
 * The design system's `Icon` draws from a global `window.lucide` (it was written against the
 * Lucide UMD build). We register only the icons the desk uses, so the bundle carries these glyphs
 * rather than the whole set.
 *
 * `Icon` renders nothing for a name it cannot find, so a screen that needs another icon adds one
 * line here (the conductor merges it). `icons.test.tsx` fails if a screen names an icon that
 * isn't registered.
 */
import {
  createElement,
  ArrowLeft,
  ArrowRight,
  Ban,
  Banknote,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  ClipboardCheck,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  FileUp,
  FlaskConical,
  History,
  House,
  Inbox,
  Info,
  Link,
  ListChecks,
  ListFilter,
  Loader,
  Lock,
  LogOut,
  Menu,
  Pencil,
  Plus,
  Receipt,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  UserRound,
  Wallet,
  X,
  type IconNode,
} from "lucide";

const icons: Record<string, IconNode> = {
  ArrowLeft, // back to the queue
  ArrowRight,
  Ban, // withdraw, write off
  Banknote, // payments
  CalendarClock, // deadlines
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert, // blocking finding
  CircleCheck, // paid, accepted
  CircleHelp,
  CircleX, // rejected
  ClipboardCheck, // assisted submission checklist
  Clock,
  Copy, // copy a literal into a portal
  Download, // packet download
  ExternalLink, // open the payer's portal
  Eye, // show an identifier
  EyeOff, // hide it again
  FileSpreadsheet, // remittance file
  FileText, // claim packet
  FileUp, // import a file
  FlaskConical, // payer simulator
  History, // claim history
  House, // today
  Inbox, // empty queue
  Info,
  Link, // match a remittance line
  ListChecks, // claims queue
  ListFilter, // queue filters
  Loader,
  Lock, // access page
  LogOut,
  Menu, // phone menu
  Pencil,
  Plus,
  Receipt,
  RefreshCw, // retry, re-import
  RotateCcw, // reopen
  Search,
  Send, // submit
  Settings,
  ShieldCheck, // approve
  Sparkles, // AI suggestion
  Trash2,
  TriangleAlert, // warning finding
  Undo2,
  Upload,
  UserRound,
  Wallet,
  X, // close
};

declare global {
  interface Window {
    lucide?: { createElement: typeof createElement; icons: Record<string, IconNode> };
  }
}

export function registerIcons() {
  window.lucide = { createElement, icons };
}
