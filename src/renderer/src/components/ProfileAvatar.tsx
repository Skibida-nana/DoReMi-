import { useEffect, useState } from 'react';
import { User } from 'lucide-react';
import type { LocalUserProfile } from '../../../shared/types/stage5';

interface ProfileAvatarProps {
  profile: LocalUserProfile;
  sizePx?: number;
  accentHex?: string;
  /** When true on animated GIFs, renders a static first-frame preview without altering the stored GIF */
  pauseAnimatedGif?: boolean;
  className?: string;
}

function getInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return '';
  }
  if (words.length === 1) {
    return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
  }
  const first = Array.from(words[0])[0] ?? '';
  const last = Array.from(words[words.length - 1])[0] ?? '';
  return `${first}${last}`.toUpperCase();
}

/**
 * Circular local user avatar supporting JPG, PNG, WEBP, and Animated GIF.
 * Animated GIFs render directly via <img> to preserve native multi-frame animation.
 * When `pauseAnimatedGif` is enabled (Reduced Motion mode), draws frame 0 to a local
 * static data URL while keeping the original GIF file untouched in storage.
 */
export function ProfileAvatar({
  profile,
  sizePx = 42,
  accentHex = '#8B5CF6',
  pauseAnimatedGif = false,
  className = '',
}: ProfileAvatarProps) {
  const [imageError, setImageError] = useState(false);
  const [staticGifDataUrl, setStaticGifDataUrl] = useState<string | null>(null);

  useEffect(() => {
    setImageError(false);
    setStaticGifDataUrl(null);
  }, [profile.avatarUrl, profile.avatarHash]);

  useEffect(() => {
    if (!pauseAnimatedGif || !profile.avatarIsAnimated || !profile.avatarUrl) {
      setStaticGifDataUrl(null);
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        const dim = Math.max(64, Math.min(256, img.naturalWidth || 128));
        canvas.width = dim;
        canvas.height = dim;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const scale = Math.max(dim / (img.naturalWidth || dim), dim / (img.naturalHeight || dim));
        const dw = (img.naturalWidth || dim) * scale;
        const dh = (img.naturalHeight || dim) * scale;
        ctx.drawImage(img, (dim - dw) / 2, (dim - dh) / 2, dw, dh);
        setStaticGifDataUrl(canvas.toDataURL('image/png'));
      } catch {
        setStaticGifDataUrl(null);
      }
    };
    img.src = profile.avatarUrl;

    return () => {
      cancelled = true;
    };
  }, [pauseAnimatedGif, profile.avatarIsAnimated, profile.avatarUrl]);

  const effectiveSrc =
    pauseAnimatedGif && profile.avatarIsAnimated && staticGifDataUrl
      ? staticGifDataUrl
      : profile.avatarUrl;

  const initials = getInitials(profile.displayName);

  return (
    <div
      style={{
        width: sizePx,
        height: sizePx,
        background:
          !effectiveSrc || imageError
            ? `linear-gradient(135deg, ${accentHex} 0%, rgba(15, 18, 28, 0.85) 100%)`
            : undefined,
      }}
      className={`relative shrink-0 overflow-hidden rounded-full border border-[var(--border-glass)] shadow-md select-none ${className}`}
    >
      {effectiveSrc && !imageError ? (
        <img
          src={effectiveSrc}
          alt={profile.displayName}
          draggable={false}
          onError={() => setImageError(true)}
          className="h-full w-full object-cover object-center"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-white">
          {initials ? (
            <span
              className="font-display font-semibold tracking-tight"
              style={{ fontSize: Math.max(12, Math.round(sizePx * 0.34)) }}
            >
              {initials}
            </span>
          ) : (
            <User className="h-[46%] w-[46%] opacity-90" />
          )}
        </div>
      )}
    </div>
  );
}
