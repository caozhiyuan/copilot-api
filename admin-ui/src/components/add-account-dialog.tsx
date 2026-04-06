import { CircleCheckIcon, OctagonXIcon } from "lucide-react"
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
import { cn } from "@/lib/utils"
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

type Step = "select-type" | "confirm-reauth" | "authorize" | "success" | "error"

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  /** Pre-fill for reauth flow */
  reauthAccountId?: string
}

const ACCOUNT_TYPES: AccountType[] = ["individual", "business", "enterprise"]

const WARNING_THRESHOLD_S = 120 // 2 minutes

/** Strip protocol prefix and trailing slashes from an enterprise domain input. */
function cleanDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

export function AddAccountDialog({
  open,
  onOpenChange,
  onSuccess,
  reauthAccountId,
}: AddAccountDialogProps): React.JSX.Element {
  const { t } = useTranslation()

  const [step, setStep] = useState<Step>(reauthAccountId ? "confirm-reauth" : "select-type")
  const [accountType, setAccountType] = useState<AccountType>("individual")
  const [enterpriseDomain, setEnterpriseDomain] = useState("")
  const [authSession, setAuthSession] = useState<AuthStartResponse | null>(null)
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const expiresAtRef = useRef<number>(0)

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current)
      countdownRef.current = null
    }
    setRemainingSeconds(null)
  }, [])

  const startCountdown = useCallback(
    (expiresInSeconds: number) => {
      clearCountdown()
      expiresAtRef.current = Date.now() + expiresInSeconds * 1000
      setRemainingSeconds(expiresInSeconds)

      countdownRef.current = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((expiresAtRef.current - Date.now()) / 1000))
        setRemainingSeconds(remaining)
        if (remaining <= 0) {
          clearCountdown()
        }
      }, 1000)
    },
    [clearCountdown],
  )

  const startPolling = useCallback(
    (sessionId: string, interval: number) => {
      if (pollingRef.current) clearInterval(pollingRef.current)

      pollingRef.current = setInterval(async () => {
        try {
          const status = await getAuthStatus(sessionId)
          setAuthStatus(status)

          if (status.status === "completed") {
            if (pollingRef.current) clearInterval(pollingRef.current)
            pollingRef.current = null
            clearCountdown()
            setStep("success")
          } else if (status.status === "failed") {
            if (pollingRef.current) clearInterval(pollingRef.current)
            pollingRef.current = null
            clearCountdown()
            setError(status.error ?? t("accountManagement.authFailed"))
            setStep("error")
          } else if (status.status === "expired") {
            if (pollingRef.current) clearInterval(pollingRef.current)
            pollingRef.current = null
            clearCountdown()
            setError(t("accountManagement.expired"))
            setStep("error")
          }
        } catch {
          // Ignore polling errors — will retry on next tick
        }
      }, (interval + 1) * 1000)
    },
    [t, clearCountdown],
  )

  const startReauth = useCallback(async () => {
    if (!reauthAccountId) return
    try {
      setError(null)
      const result = await reauthAccount(reauthAccountId)
      setAuthSession(result)
      setStep("authorize")
      window.open(result.verificationUri, "_blank")
      startCountdown(result.expiresIn)
      startPolling(result.sessionId, result.interval)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep("error")
    }
  }, [reauthAccountId, startPolling, startCountdown])

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current)
        countdownRef.current = null
      }
      const timer = setTimeout(() => {
        setStep(reauthAccountId ? "confirm-reauth" : "select-type")
        setAccountType("individual")
        setEnterpriseDomain("")
        setAuthSession(null)
        setAuthStatus(null)
        setError(null)
        setCopied(false)
        setRemainingSeconds(null)
      }, 200)
      return () => clearTimeout(timer)
    }
  }, [open, reauthAccountId])

  const handleContinue = useCallback(async () => {
    const domain = cleanDomain(enterpriseDomain)

    if (accountType === "enterprise" && !domain) {
      setError(t("accountManagement.enterpriseDomainRequired"))
      return
    }

    try {
      setError(null)
      const result = await startAccountAuth({
        accountType,
        enterpriseDomain: accountType === "enterprise" ? domain : undefined,
      })
      setAuthSession(result)
      setStep("authorize")
      window.open(result.verificationUri, "_blank")
      startCountdown(result.expiresIn)
      startPolling(result.sessionId, result.interval)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep("error")
    }
  }, [accountType, enterpriseDomain, t, startPolling, startCountdown])

  const handleCancel = useCallback(async () => {
    if (authSession) {
      await cancelAuth(authSession.sessionId).catch(() => {})
    }
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    clearCountdown()
    onOpenChange(false)
  }, [authSession, onOpenChange, clearCountdown])

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
    clearCountdown()
    setStep(reauthAccountId ? "confirm-reauth" : "select-type")
  }, [reauthAccountId, clearCountdown])

  const handleDomainBlur = useCallback(() => {
    setEnterpriseDomain((prev) => cleanDomain(prev))
  }, [])

  // Determine if the error is an expiration error for contextual hint
  const isExpiredError = error === t("accountManagement.expired")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {step === "select-type" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("accountManagement.addAccount")}</DialogTitle>
              <DialogDescription>{t("accountManagement.selectAccountType")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2" role="radiogroup" aria-label={t("accountManagement.selectAccountType")}>
              {ACCOUNT_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={accountType === type}
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
                    <div className="font-medium">
                      {t(
                        `accountManagement.type${type.charAt(0).toUpperCase() + type.slice(1)}`,
                      )}
                    </div>
                    <div className="text-muted-foreground text-sm">
                      {t(
                        `accountManagement.type${type.charAt(0).toUpperCase() + type.slice(1)}Description`,
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
            {accountType === "enterprise" && (
              <div className="space-y-2">
                <Label htmlFor="enterprise-domain">
                  {t("accountManagement.enterpriseDomain")}{" "}
                  <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="enterprise-domain"
                  placeholder={t("accountManagement.enterpriseDomainPlaceholder")}
                  value={enterpriseDomain}
                  onChange={(e) => setEnterpriseDomain(e.target.value)}
                  onBlur={handleDomainBlur}
                />
                <p className="text-muted-foreground text-xs">
                  {t("accountManagement.enterpriseDomainHint")}
                </p>
              </div>
            )}
            {error && (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("accountManagement.cancel")}
              </Button>
              <Button onClick={handleContinue}>{t("accountManagement.continue")}</Button>
            </DialogFooter>
          </>
        )}

        {step === "confirm-reauth" && reauthAccountId && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t("accountManagement.reauthAuthorizeTitle", { id: reauthAccountId })}
              </DialogTitle>
              <DialogDescription>
                {t("accountManagement.reauthConfirmDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="text-muted-foreground space-y-2 py-2 text-sm">
              <p>{t("accountManagement.reauthConfirmHint")}</p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("accountManagement.cancel")}
              </Button>
              <Button onClick={() => void startReauth()}>
                {t("accountManagement.continue")}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "authorize" && authSession && (
          <>
            <DialogHeader>
              <DialogTitle>
                {reauthAccountId
                  ? t("accountManagement.reauthAuthorizeTitle", { id: reauthAccountId })
                  : t("accountManagement.authorizeTitle")}
              </DialogTitle>
              {reauthAccountId && (
                <DialogDescription>
                  {t("accountManagement.reauthAuthorizeDescription")}
                </DialogDescription>
              )}
            </DialogHeader>
            <div className="flex flex-col items-center gap-4 py-4">
              <p className="text-muted-foreground text-sm">
                {t("accountManagement.enterCodePrompt")}
              </p>
              <div className="border-primary/50 bg-muted relative w-full rounded-lg border-2 border-dashed p-4 text-center">
                <code className="text-2xl font-bold tracking-[0.3em]">
                  {authSession.userCode}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-2 top-1/2 h-7 -translate-y-1/2 px-2 text-xs"
                  onClick={handleCopyCode}
                >
                  {copied ? t("accountManagement.copied") : t("accountManagement.copy")}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                {t("accountManagement.autoOpenHint")}
              </p>
              <a
                href={authSession.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary text-sm underline"
              >
                {authSession.verificationUri}
              </a>
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    "h-2 w-2 rounded-full motion-safe:animate-pulse",
                    remainingSeconds != null && remainingSeconds <= WARNING_THRESHOLD_S
                      ? "bg-amber-500"
                      : "bg-primary",
                  )}
                />
                <span
                  className={cn(
                    "text-sm",
                    remainingSeconds != null && remainingSeconds <= WARNING_THRESHOLD_S
                      ? "text-amber-500 font-medium"
                      : "text-muted-foreground",
                  )}
                >
                  {remainingSeconds != null && remainingSeconds > 0
                    ? t("accountManagement.expiresIn", {
                        time: formatCountdown(remainingSeconds),
                      })
                    : t("accountManagement.waitingForAuth")}
                </span>
              </div>
              {remainingSeconds != null && remainingSeconds <= WARNING_THRESHOLD_S && remainingSeconds > 0 && (
                <p className="text-amber-500 text-xs">{t("accountManagement.expiresWarning")}</p>
              )}
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
                  ? t("accountManagement.successReauthTitle", { id: reauthAccountId })
                  : t("accountManagement.successTitle")}
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-4 py-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-300">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
                <CircleCheckIcon className="size-6 text-green-500" />
              </div>
              <div className="bg-muted w-full rounded-lg p-4 text-sm">
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">
                    {t("accountManagement.accountLabel")}
                  </span>
                  <span className="font-medium">{authStatus?.accountId ?? "\u2014"}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">
                    {t("accountManagement.typeLabel")}
                  </span>
                  <span>
                    {t(
                      `accountManagement.type${accountType.charAt(0).toUpperCase() + accountType.slice(1)}`,
                    )}
                  </span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">
                    {t("accountManagement.statusLabel")}
                  </span>
                  <span className="text-green-500">
                    {t("accountManagement.statusActive")}
                  </span>
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
            <div className="flex flex-col items-center gap-4 py-4" role="alert">
              <div className="bg-destructive/10 flex h-12 w-12 items-center justify-center rounded-full">
                <OctagonXIcon className="text-destructive size-6" />
              </div>
              <div className="bg-destructive/5 border-destructive/20 w-full rounded-lg border p-4">
                <p className="text-destructive text-sm font-medium">{error}</p>
              </div>
              <p className="text-muted-foreground text-center text-xs">
                {isExpiredError
                  ? t("accountManagement.errorExpiredHint")
                  : t("accountManagement.errorRecoveryHint")}
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("accountManagement.cancel")}
              </Button>
              <Button onClick={handleStartOver}>{t("accountManagement.startOver")}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
