import type { IconSvgElement } from "@/components/icons";
import {
  Activity01Icon,
  AiCloudIcon,
  AiMagicIcon,
  Analytics01Icon,
  AudioBook01Icon,
  BarChartHorizontalIcon,
  BulbIcon,
  ChartLineData01Icon,
  CompassIcon,
  Clock01Icon,
  CloudServerIcon,
  Folder01Icon,
  Coins01Icon,
  Film01Icon,
  FlashIcon,
  GameController01Icon,
  HealthIcon,
  House01Icon,
  MoneySavingJarIcon,
  More02Icon,
  Package01Icon,
  PiggyBankIcon,
  ReceiptDollarIcon,
  ShoppingBasket02Icon,
  SourceCodeCircleIcon,
  Train01Icon,
  TransactionHistoryIcon,
  Wallet01Icon,
} from "@/components/icons";

const NATIVE_APP_ICONS: Record<string, IconSvgElement> = {
  activity: Activity01Icon,
  timer: Clock01Icon,
  server: CloudServerIcon,
  folder: Folder01Icon,
  assistant: AiMagicIcon,
  analytics: Analytics01Icon,
  "budget-bars": BarChartHorizontalIcon,
  "cash-flow": ChartLineData01Icon,
  "money-saving-jar": MoneySavingJarIcon,
  savings: PiggyBankIcon,
  spending: ReceiptDollarIcon,
  transactions: TransactionHistoryIcon,
  wallet: Wallet01Icon,
};

const BUDGET_CATEGORY_ICONS: Record<string, IconSvgElement> = {
  groceries: ShoppingBasket02Icon,
  health: HealthIcon,
  housing: House01Icon,
  income: Coins01Icon,
  leisure: GameController01Icon,
  other: More02Icon,
  transport: Train01Icon,
  utilities: BulbIcon,
};

export function resolveNativeAppIcon(key?: string): IconSvgElement {
  return (key && NATIVE_APP_ICONS[key]) || Wallet01Icon;
}

export function isNativeAppIcon(key?: string): boolean {
  return Boolean(key && NATIVE_APP_ICONS[key]);
}

/**
 * Resolve catalog and user-built application metadata to the Talome icon set.
 * App metadata may still contain a legacy emoji, but UI surfaces must never
 * render that text glyph as the application icon.
 */
export function resolveApplicationIcon(icon?: string | null, name?: string | null): IconSvgElement {
  if (isNativeAppIcon(icon ?? undefined)) return resolveNativeAppIcon(icon ?? undefined);

  const descriptor = `${icon ?? ""} ${name ?? ""}`.toLocaleLowerCase();
  const includesAny = (...values: string[]) => values.some((value) => descriptor.includes(value));

  if (includesAny("budget", "finance", "money", "wallet", "saving", "💰", "💵")) {
    return Wallet01Icon;
  }
  if (includesAny("weather", "forecast", "storm", "rain", "cloud", "⛈", "🌦")) {
    return AiCloudIcon;
  }
  if (includesAny("stopwatch", "timer", "⏱")) return Clock01Icon;
  if (includesAny("movie", "media", "video", "cinema", "jellyfin", "🎬", "📺")) {
    return Film01Icon;
  }
  if (includesAny("audio", "book", "read", "library", "📚", "🎧")) {
    return AudioBook01Icon;
  }
  if (includesAny("strategy", "intelligence", "insight", "compass", "🧭")) {
    return CompassIcon;
  }
  if (includesAny("assistant", "agent", "ai ", "magic", "spark", "🤖", "✨")) {
    return AiMagicIcon;
  }
  if (includesAny("automation", "workflow", "zap", "⚡")) {
    return FlashIcon;
  }
  if (includesAny("code", "developer", "terminal", "script", "api")) {
    return SourceCodeCircleIcon;
  }
  if (includesAny("analytics", "metric", "chart", "report")) {
    return Analytics01Icon;
  }
  if (includesAny("health", "medical", "fitness")) return HealthIcon;
  if (includesAny("game", "gaming")) return GameController01Icon;
  if (includesAny("shop", "store", "grocery")) return ShoppingBasket02Icon;
  if (includesAny("home", "house")) return House01Icon;

  return Package01Icon;
}

/**
 * Only pass actual image sources to Next/Image. App metadata historically also
 * stored emoji in `iconUrl`; treating that text as an image can leak the emoji
 * into the UI through browser fallback rendering.
 */
export function resolveApplicationIconUrl(iconUrl?: string | null): string | undefined {
  const value = iconUrl?.trim();
  if (!value) return undefined;
  return /^(?:https?:\/\/|data:image\/|blob:|\/)/i.test(value) ? value : undefined;
}

export function resolveBudgetCategoryIcon(category?: string): IconSvgElement {
  return (category && BUDGET_CATEGORY_ICONS[category.trim().toLowerCase()]) || Wallet01Icon;
}
