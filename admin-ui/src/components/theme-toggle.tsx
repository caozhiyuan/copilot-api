import { LaptopIcon, MoonIcon, SunIcon } from "lucide-react"
import { useTheme } from "next-themes"

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
  const { theme, setTheme } = useTheme()

  return (
    <Select value={theme ?? "system"} onValueChange={setTheme}>
      <SelectTrigger size="sm" className="w-[8.5rem]" aria-label="Theme">
        <ThemeIcon theme={theme} />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="system">System</SelectItem>
        <SelectItem value="light">Light</SelectItem>
        <SelectItem value="dark">Dark</SelectItem>
      </SelectContent>
    </Select>
  )
}
