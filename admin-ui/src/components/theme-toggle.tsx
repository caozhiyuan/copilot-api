import { LaptopIcon, MoonIcon, SunIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { useTranslation } from "react-i18next"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

function ThemeIcon({ theme }: { theme: string | undefined }): React.JSX.Element {
  if (theme === "light") return <SunIcon className="size-4" />
  if (theme === "dark") return <MoonIcon className="size-4" />
  return <LaptopIcon className="size-4" />
}

export function ThemeToggle(): React.JSX.Element {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()

  return (
    <Select value={theme ?? "system"} onValueChange={setTheme}>
      <SelectTrigger size="sm" className="w-[8.5rem]" aria-label={t("theme.label")}>
        <ThemeIcon theme={theme} />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="system">{t("theme.system")}</SelectItem>
        <SelectItem value="light">{t("theme.light")}</SelectItem>
        <SelectItem value="dark">{t("theme.dark")}</SelectItem>
      </SelectContent>
    </Select>
  )
}
