import { useEffect, useState } from "react"
import { KeyRoundIcon } from "lucide-react"
import { toast } from "sonner"
import { Trans, useTranslation } from "react-i18next"

import { getAdminMeta, type AdminMeta, AdminApiError } from "@/lib/admin-api"
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
  const [meta, setMeta] = useState<AdminMeta | null>(null)

  const tokenStatus = token ? t("common.set") : t("common.unset")

  useEffect(() => {
    if (open) setDraft(token)
  }, [open, token])

  async function testToken(): Promise<void> {
    setTesting(true)
    setMeta(null)
    try {
      const m = await getAdminMeta()
      setMeta(m)
      toast.success(t("tokenDialog.toast.adminApiOk"))
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      toast.error(t("tokenDialog.toast.adminApiFailed"), { description: msg })
    } finally {
      setTesting(false)
    }
  }

  function save(): void {
    setToken(draft)
    toast.success(
      draft.trim()
        ? t("tokenDialog.toast.tokenSavedForSession")
        : t("tokenDialog.toast.tokenCleared")
    )
  }

  function clear(): void {
    clearToken()
    setDraft("")
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
              Used as <code>x-admin-token</code> when calling <code>/api/admin/*</code>. Stored in <code>sessionStorage</code>.
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
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
          />
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
          <Button variant="secondary" onClick={testToken} disabled={testing}>
            {testing ? t("common.testing") : t("common.test")}
          </Button>
          <Button variant="outline" onClick={clear} disabled={!token && !draft.trim()}>
            {t("common.clear")}
          </Button>
          <RainbowButton onClick={save} className="h-9 px-4">
            {t("common.save")}
          </RainbowButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
