import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Link } from "wouter";
import { getProductByQr } from "@/lib/api";
import { FlashBanner, Screen } from "@/components/ui";

type ScanState = "idle" | "scanning" | "permission_denied" | "no_camera" | "invalid" | "loading";

declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats?: string[] }) => {
      detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>;
    };
  }
}

function extractToken(raw: string): string {
  const t = raw.trim();
  try {
    const u = new URL(t);
    const q = u.searchParams.get("token") || u.searchParams.get("qr");
    if (q) return q;
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || t;
  } catch {
    return t;
  }
}

export function ScanPage() {
  const [, navigate] = useLocation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);

  const [state, setState] = useState<ScanState>("idle");
  const [error, setError] = useState("");
  const [manual, setManual] = useState("");

  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const resolveToken = useCallback(
    async (raw: string) => {
      const token = extractToken(raw);
      if (!token) {
        setState("invalid");
        setError("رمز QR غير صالح.");
        return;
      }
      setState("loading");
      setError("");
      try {
        const product = await getProductByQr(token);
        stopCamera();
        navigate(`/product/${product.id}?from=qr`);
      } catch {
        setState("invalid");
        setError("منتج غير معروف — تحقق من الرمز.");
      }
    },
    [navigate, stopCamera],
  );

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState("no_camera");
        return;
      }
      if (!window.BarcodeDetector) {
        setState("no_camera");
        setError("المتصفح لا يدعم BarcodeDetector — استخدم اللصق اليدوي.");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setState("scanning");

        const detector = new window.BarcodeDetector!({ formats: ["qr_code"] });

        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0 && codes[0].rawValue) {
              await resolveToken(codes[0].rawValue);
              return;
            }
          } catch {
            /* ignore frame errors */
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/denied|permission|NotAllowed/i.test(msg)) {
          setState("permission_denied");
          setError("تم رفض إذن الكاميرا.");
        } else {
          setState("no_camera");
          setError("تعذّر فتح الكاميرا.");
        }
      }
    }

    start();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [resolveToken, stopCamera]);

  return (
    <Screen title="مسح QR" backTo="/">
      <Link href="/search" className="btn-lg btn-secondary mb-4">
        بحث يدوي
      </Link>

      <FlashBanner message={error} onDismiss={() => setError("")} />

      {state === "scanning" || state === "loading" ? (
        <div className="card overflow-hidden p-0">
          <video ref={videoRef} className="aspect-square w-full bg-black object-cover" playsInline muted />
          <p className="p-3 text-center text-sm font-semibold text-[hsl(var(--muted-foreground))]">
            {state === "loading" ? "جاري التحميل..." : "وجّه الكاميرا نحو رمز QR"}
          </p>
        </div>
      ) : state === "permission_denied" ? (
        <div className="card py-8 text-center">
          <p className="font-bold">تم رفض إذن الكاميرا</p>
          <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">فعّل الكاميرا من إعدادات المتصفح ثم أعد المحاولة.</p>
        </div>
      ) : state === "no_camera" ? (
        <div className="card py-8 text-center">
          <p className="font-bold">الكاميرا غير متاحة</p>
          <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">استخدم اللصق اليدوي أدناه.</p>
        </div>
      ) : state === "invalid" ? (
        <div className="card py-8 text-center">
          <p className="font-bold">رمز غير معروف</p>
        </div>
      ) : null}

      <div className="card mt-4 space-y-3">
        <label className="block">
          <span className="mb-2 block text-sm font-bold">لصق الرمز يدوياً</span>
          <input
            className="input-lg"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="الصق رمز QR..."
          />
        </label>
        <button
          type="button"
          className="btn-lg btn-primary"
          disabled={!manual.trim() || state === "loading"}
          onClick={() => resolveToken(manual)}
        >
          تأكيد الرمز
        </button>
      </div>
    </Screen>
  );
}
