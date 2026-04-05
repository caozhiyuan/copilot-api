import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  type AccountType,
  type AuthStartResponse,
  type AuthStatusResponse,
  cancelAuth,
  getAuthStatus,
  reauthAccount,
  startAccountAuth,
} from "@/lib/admin-api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Step = "select-type" | "authorize" | "success" | "error"

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  /** Pre-fill for reauth flow */
  reauthAccountId?: string
}

const ACCOUNT_TYPES: AccountType[] = ["individual", "business", "enterprise"]

export function AddAccountDialog({
  open,
  onOpenChange,
  onSuccess,
  reauthAccountId,
}: AddAccountDialogProps): React.JSX.Element {
  const { t } = useTranslation()

  const [step, setStep] = useState<Step>(reauthAccountId ? "authorize" : "select-type")
  const [accountType, setAccountType] = useState<AccountType>("individual")
  const [enterpriseDomain, setEnterpriseDomain] = useState("")
  const [authSession, setAuthSession] = useState<AuthStartResponse | null>(null)
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
      const timer = setTimeout(() => {
        setStep(reauthAccountId ? "authorize" : "select-type")
        setAccountType("individual")
        setEnterpriseDomain("")
        setAuthSession(null)
        setAuthStatus(null)
        setError(null)
        setCopied(false)
      }, 200)
      return () => clearTimeout(timer)
    }

    if (reauthAccountId && open) {
      void startReauth()
    }
  }, [open, reauthAccountId])

  const startReauth = useCallback(async () => {
    if (!reauthAccountId) return
    try {
      setError(null)
      const result = await reauthAccount(reauthAccountId)
      setAuthSession(result)
      setStep("authorize")
      window.open(result.verificationUri, "_blank")
      startPolling(result.sessionId, result.interval)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep("error")
    }
  }, [reauthAccountId])

  const handleContinue = useCallback(async () => {
    if (accountType === "enterprise" && !enterpriseDomain.trim()) {
      setError(t("accountManagement.enterpriseDomainRequired"))
      return
    }

    try {
      setError(null)
      const result = await startAccountAuth({
        accountType,
        enterpriseDomain: accountType === "enterprise" ? enterpriseDomain.trim() : undefined,
      })
      setAuthSession(result)
      setStep("authorize")
      window.open(result.verificationUri, "_blank")
      startPolling(result.sessionId, result.interval)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep("error")
    }
  }, [accountType, enterpriseDomain, t])

  const startPolling = useCallback((sessionId: string, interval: number) => {
    if (pollingRef.current) clearInterval(pollingRef.current)

    pollingRef.current = setInterval(async () => {
      try {
        const status = await getAuthStatus(sessionId)
        setAuthStatus(status)

        if (status.status === "completed") {
          if (pollingRef.current) clearInterval(pollingRef.current)
          pollingRef.current = null
          setStep("success")
        } else if (status.status === "failed") {
          if (pollingRef.current) clearInterval(pollingRef.current)
          pollingRef.current = null
          setError(status.error ?? t("accountManagement.authFailed"))
          setStep("error")
        } else if (status.status === "expired") {
          if (pollingRef.current) clearInterval(pollingRef.current)
          pollingRef.current = null
          setError(t("accountManagement.expired"))
          setStep("error")
        }
      } catch {
        // Ignore polling errors — will retry on next tick
      }
    }, (interval + 1) * 1000)
  }, [t])

  const handleCancel = useCallback(async () => {
    if (authSession) {
      await cancelAuth(authSession.sessionId).catch(() => {})
    }
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    onOpenChange(false)
  }, [authSession, onOpenChange])

  const handleDone = useCallback(() => {
    onOpenChange(false)
    onSuccess()
  }, [onOpenChange, onSuccess])

  const handleCopyCode = useCallback(async () => {
    if (!authSession) return
    await navigator.clipboard.writeText(authSession.userCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [authSession])

  const handleStartOver = useCallback(() => {
    setError(null)
    setAuthSession(null)
    setAuthStatus(null)
    setStep(reauthAccountId ? "authorize" : "select-type")
    if (reauthAccountId) {
      void startReauth()
    }
  }, [reauthAccountId, startReauth])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {step === "select-type" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("accountManagement.addAccount")}</DialogTitle>
              <DialogDescription>{t("accountManagement.selectAccountType")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              {ACCOUNT_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setAccountType(type)}
                  className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                    accountType === type
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <div
                    className={`flex h-5 w-5 items-center justify-center rounded-full border-2 ${
                      accountType === type ? "border-primary" : "border-muted-foreground"
                    }`}
                  >
                    {accountType === type && (
                      <div className="bg-primary h-2.5 w-2.5 rounded-full" />
                    )}
                  </div>
                  <div>
                    <div className="font-medium">{t(`accountManagement.type${type.charAt(0).toUpperCase() + type.slice(1)}`)}</div>
                    <div className="text-muted-foreground text-sm">
                      {t(`accountManagement.type${type.charAt(0).toUpperCase() + type.slice(1)}Description`)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
            {accountType === "enterprise" && (
              <div className="space-y-2">
                <Label htmlFor="enterprise-domain">
                  {t("accountManagement.enterpriseDomain")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="enterprise-domain"
                  placeholder={t("accountManagement.enterpriseDomainPlaceholder")}
                  value={enterpriseDomain}
                  onChange={(e) => setEnterpriseDomain(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">{t("accountManagement.enterpriseDomainHint")}</p>
              </div>
            )}
            {error && <p className="text-destructive text-sm">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("accountManagement.cancel")}
              </Button>
              <Button onClick={handleContinue}>
                {t("accountManagement.continue")}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "authorize" && authSession && (
          <>
            <DialogHeader>
              <DialogTitle>{t("accountManagement.authorizeTitle")}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-4 py-4">
              <p className="text-muted-foreground text-sm">{t("accountManagement.enterCodePrompt")}</p>
              <div className="relative w-full rounded-lg border-2 border-dashed border-primary/50 bg-muted p-4 text-center">
                <code className="text-2xl font-bold tracking-[0.3em]">{authSession.userCode}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-2 top-2 h-7 px-2 text-xs"
                  onClick={handleCopyCode}
                >
                  {copied ? t("accountManagement.copied") : t("accountManagement.copy")}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">{t("accountManagement.autoOpenHint")}</p>
              <a
                href={authSession.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary text-sm underline"
              >
                {authSession.verificationUri}
              </a>
              <div className="flex items-center gap-2">
                <div className="bg-primary h-2 w-2 animate-pulse rounded-full" />
                <span className="text-muted-foreground text-sm">{t("accountManagement.waitingForAuth")}</span>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={handleCancel}>
                {t("accountManagement.cancel")}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "success" && (
          <>
            <DialogHeader>
              <DialogTitle>
                {reauthAccountId
                  ? t("accountManagement.successReauthTitle")
                  : t("accountManagement.successTitle")}
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-500">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <div className="bg-muted w-full rounded-lg p-4 text-sm">
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">{t("accountManagement.accountLabel")}</span>
                  <span className="font-medium">{authStatus?.accountId ?? "—"}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">{t("accountManagement.typeLabel")}</span>
                  <span>{accountType}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">{t("accountManagement.statusLabel")}</span>
                  <span className="text-green-500">{t("accountManagement.statusActive")}</span>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleDone}>{t("accountManagement.done")}</Button>
            </DialogFooter>
          </>
        )}

        {step === "error" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("accountManagement.authFailed")}</DialogTitle>
            </DialogHeader>
            <div className="py-4">
              <p className="text-destructive text-sm">{error}</p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("accountManagement.cancel")}
              </Button>
              <Button onClick={handleStartOver}>
                {t("accountManagement.startOver")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
