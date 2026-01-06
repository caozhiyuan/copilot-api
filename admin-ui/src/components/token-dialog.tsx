import { useEffect, useMemo, useState } from "react"
import { KeyRoundIcon } from "lucide-react"
import { toast } from "sonner"

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
import { RainbowButton } from "@/registry/magicui/rainbow-button"

export function TokenDialog(): React.JSX.Element {
  const { token, setToken, clearToken } = useAdminToken()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(token)
  const [testing, setTesting] = useState(false)
  const [meta, setMeta] = useState<AdminMeta | null>(null)

  const tokenStatus = useMemo(() => {
    return token ? "set" : "unset"
  }, [token])

  useEffect(() => {
    if (open) setDraft(token)
  }, [open, token])

  async function testToken(): Promise<void> {
    setTesting(true)
    setMeta(null)
    try {
      const m = await getAdminMeta()
      setMeta(m)
      toast.success("Admin API access OK")
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      toast.error("Admin API access failed", { description: msg })
    } finally {
      setTesting(false)
    }
  }

  function save(): void {
    setToken(draft)
    toast.success(draft.trim() ? "Token saved for this session" : "Token cleared")
  }

  function clear(): void {
    clearToken()
    setDraft("")
    toast.success("Token cleared")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <KeyRoundIcon className="size-4" />
          Token
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
          <DialogTitle>Admin token</DialogTitle>
          <DialogDescription>
            Used as <code>x-admin-token</code> when calling <code>/api/admin/*</code>. Stored
            in <code>sessionStorage</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label htmlFor="admin-token">x-admin-token</Label>
          <Input
            id="admin-token"
            type="password"
            placeholder="Enter token"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
          />
          <p className="text-muted-foreground text-xs">
            If the server is not running on localhost, you must set <code>ADMIN_TOKEN</code>
            on the server to enable remote access.
          </p>
          {meta?.dbPath && (
            <p className="text-muted-foreground text-xs">
              Connected: DB v{meta.userVersion ?? "?"} · {meta.dbPath}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="secondary" onClick={testToken} disabled={testing}>
            {testing ? "Testing..." : "Test"}
          </Button>
          <Button variant="outline" onClick={clear} disabled={!token && !draft.trim()}>
            Clear
          </Button>
          <RainbowButton onClick={save} className="h-9 px-4">
            Save
          </RainbowButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
