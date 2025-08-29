// Lightweight utility to safely manage synthetic history entries for overlays.
// Ensures programmatic closes don't call history.back() unless this overlay
// is on top of the overlay stack, avoiding accidental navigation.

type OverlayEntry = {
  token: string;
  marker: string;
  handler: () => void;
  active: boolean;
};

const stack: OverlayEntry[] = [];
let popListenerInstalled = false;

function ensurePopListener() {
  if (popListenerInstalled) return;
  popListenerInstalled = true;
  window.addEventListener('popstate', () => {
    try {
      if (stack.length === 0) return;
      const ent = stack.pop();
      if (ent && ent.active) {
        try { ent.handler(); } catch {}
        ent.active = false;
      }
    } catch {}
  });
}

function randomToken() {
  return Math.random().toString(36).slice(2, 10);
}

export type OverlayHandle = {
  token: string;
  marker: string;
  close: () => void;
};

export function pushOverlay(marker: string, onBack: () => void): OverlayHandle {
  ensurePopListener();
  const token = randomToken();
  const entry: OverlayEntry = { token, marker, handler: onBack, active: true };
  stack.push(entry);
  try {
    history.pushState({ ...history.state, __m3_overlay: marker, __m3_overlay_id: token }, "", location.href);
  } catch {}

  return {
    token,
    marker,
    close: () => {
      try {
        // If this entry is the top of our overlay stack, consume it via history.back()
        const top = stack.length ? stack[stack.length - 1] : null;
        if (top && top.token === token) {
          try { history.back(); } catch {}
          return;
        }
        // Otherwise, unregister and mark inactive; do NOT call history.back() because
        // another overlay or real navigation has been pushed on top of this entry.
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].token === token) {
            stack.splice(i, 1);
            break;
          }
        }
        entry.active = false;
      } catch {}
    }
  };
}


