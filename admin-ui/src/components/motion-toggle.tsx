import { BanIcon, SparklesIcon, WavesIcon } from "lucide-react"

import {
  type MotionPreference,
  useMotionPreference,
} from "@/lib/motion-preference"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

function MotionIcon({ value }: { value: MotionPreference }): React.JSX.Element {
  if (value === "magic") return <SparklesIcon className="size-4" />
  if (value === "subtle") return <WavesIcon className="size-4" />
  return <BanIcon className="size-4" />
}

export function MotionToggle(): React.JSX.Element {
  const { preference, reducedMotion, setPreference } = useMotionPreference()
  const value: MotionPreference = reducedMotion ? "off" : preference

  return (
    <Select
      value={value}
      onValueChange={(v) => setPreference(v as MotionPreference)}
      disabled={reducedMotion}
    >
      <SelectTrigger
        size="sm"
        className="w-[8.5rem]"
        aria-label="Motion"
        title={reducedMotion ? "Reduced motion is enabled in system settings" : undefined}
      >
        <MotionIcon value={value} />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="magic">Magic</SelectItem>
        <SelectItem value="subtle">Subtle</SelectItem>
        <SelectItem value="off">Off</SelectItem>
      </SelectContent>
    </Select>
  )
}
