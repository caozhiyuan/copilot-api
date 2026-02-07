import { useEffect, useState } from "react"
import { KeyRoundIcon } from "lucide-react"
import { Trans, useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  ADMIN_TOKEN_REQUIRED_EVENT,
  AdminApiError,
  getAdminMeta,
  type AdminMeta,
} from "@/lib/admin-api"
import { useAdminToken } from "@/lib/admin-token"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RainbowButton } from "@/components/ui/rainbow-button"

export function TokenDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const { token, setToken, clearToken } = useAdminToken()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(token)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [meta, setMeta] = useState<AdminMeta | null>(null)

  const tokenStatus = token ? t("common.set") : t("common.unset")

  useEffect(() => {
    if (typeof window === "undefined") return

    function handleTokenRequired(): void {
      setOpen(true)
    }

    window.addEventListener(ADMIN_TOKEN_REQUIRED_EVENT, handleTokenRequired)
    return () => {
      window.removeEventListener(ADMIN_TOKEN_REQUIRED_EVENT, handleTokenRequired)
    }
  }, [])

  useEffect(() => {
    if (open) setDraft(token)
    if (open) setSaveError(null)
  }, [open, token])

  async function testToken(): Promise<void> {
    setTesting(true)
    setMeta(null)
    setSaveError(null)
    try {
      const m = await getAdminMeta(draft)
      setMeta(m)
      toast.success(t("tokenDialog.toast.adminApiOk"))
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      toast.error(t("tokenDialog.toast.adminApiFailed"), { description: msg })
    } finally {
      setTesting(false)
    }
  }

  async function save(): Promise<void> {
    const trimmed = draft.trim()
    if (!trimmed) {
      setSaveError(t("tokenDialog.validation.empty"))
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const m = await getAdminMeta(trimmed)
      setMeta(m)
      setToken(trimmed)
      setOpen(false)
      toast.success(t("tokenDialog.toast.tokenSaved"))
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      setSaveError(msg)
    } finally {
      setSaving(false)
    }
  }

  function clear(): void {
    clearToken()
    setDraft("")
    setSaveError(null)
    setMeta(null)
    toast.success(t("tokenDialog.toast.tokenCleared"))
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <KeyRoundIcon className="size-4" />
          {t("tokenDialog.trigger")}
          <Badge
            variant={token ? "secondary" : "outline"}
            className="ml-1 hidden sm:inline-flex"
          >
            {tokenStatus}
          </Badge>
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("tokenDialog.title")}</DialogTitle>
          <DialogDescription>
            <Trans i18nKey="tokenDialog.description">
              Used as <code>x-admin-token</code> when calling <code>/api/admin/*</code>. Stored in <code>localStorage</code>.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label htmlFor="admin-token">x-admin-token</Label>
          <Input
            id="admin-token"
            type="password"
            placeholder={t("tokenDialog.inputPlaceholder")}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              if (saveError) setSaveError(null)
            }}
            autoComplete="off"
          />
          {saveError ? (
            <p className="text-destructive text-xs">{saveError}</p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            <Trans i18nKey="tokenDialog.remoteNote">
              If the server is not running on localhost, you must set <code>ADMIN_TOKEN</code> on the server to enable remote access.
            </Trans>
          </p>
          {meta?.dbPath && (
            <p className="text-muted-foreground text-xs">
              {t("tokenDialog.connected", {
                version: meta.userVersion ?? "?",
                path: meta.dbPath,
              })}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="secondary"
            onClick={testToken}
            disabled={testing || saving}
          >
            {testing ? t("common.testing") : t("common.test")}
          </Button>
          <Button
            variant="outline"
            onClick={clear}
            disabled={(!token && !draft.trim()) || testing || saving}
          >
            {t("common.clear")}
          </Button>
          <RainbowButton
            onClick={save}
            className="h-9 px-4"
            disabled={testing || saving}
          >
            {t("common.save")}
          </RainbowButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
