import { GlobeIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { normalizeLocale } from "@/lib/i18n"
import { useLocalePreference } from "@/lib/locale-preference"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function LocaleToggle(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale, setLocale } = useLocalePreference()

  return (
    <Select value={locale} onValueChange={(value) => setLocale(normalizeLocale(value))}>
      <SelectTrigger size="sm" className="w-[8.5rem]" aria-label={t("app.language")}>
        <GlobeIcon className="size-4" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="en-US">{t("locale.enUS")}</SelectItem>
        <SelectItem value="zh-CN">{t("locale.zhCN")}</SelectItem>
      </SelectContent>
    </Select>
  )
}
