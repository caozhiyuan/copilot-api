import { LoaderCircleIcon } from "lucide-react"
import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { deleteAccount } from "@/lib/admin-api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface DeleteAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountId: string
  onDeleted: () => void
}

export function DeleteAccountDialog({
  open,
  onOpenChange,
  accountId,
  onDeleted,
}: DeleteAccountDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [deleting, setDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteAccount(accountId)
      toast.success(t("accountManagement.deleteSuccess", { id: accountId }))
      onOpenChange(false)
      onDeleted()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }, [accountId, onDeleted, onOpenChange, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("accountManagement.deleteTitle")}</DialogTitle>
          <DialogDescription>
            {t("accountManagement.deleteConfirmation", { id: accountId })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            {t("accountManagement.cancel")}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? (
              <>
                <LoaderCircleIcon className="size-4 animate-spin" />
                {t("accountManagement.deleting")}
              </>
            ) : (
              t("accountManagement.delete")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
