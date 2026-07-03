// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import { useEffect, useState } from 'react';

/**
 * Simple vs advanced UI mode.
 *
 * Tenant operators mostly need four jobs (see chargers, onboard a charger, set
 * prices, watch sessions/money); everything else -- per-EVSE topology editing,
 * device model, OCPI partners, raw OCPP logs -- is platform-operator territory
 * and easy to get wrong by hand. The UI therefore defaults to a reduced
 * "simple" surface and puts the full one behind this toggle.
 *
 * Persisted per browser in localStorage; components in the same tab stay in
 * sync via a window event (the native `storage` event only fires cross-tab).
 */

const STORAGE_KEY = 'ui-mode';
const CHANGE_EVENT = 'ui-mode-changed';

export type UiMode = 'simple' | 'advanced';

function readStoredMode(): UiMode {
  if (typeof window === 'undefined') return 'simple';
  return window.localStorage.getItem(STORAGE_KEY) === 'advanced' ? 'advanced' : 'simple';
}

export function useUiMode(): { advanced: boolean; setAdvanced: (advanced: boolean) => void } {
  // Start with the simple default on both server and client so hydration
  // matches, then sync to the stored preference after mount.
  const [mode, setMode] = useState<UiMode>('simple');

  useEffect(() => {
    setMode(readStoredMode());
    const onChange = () => setMode(readStoredMode());
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  const setAdvanced = (advanced: boolean) => {
    window.localStorage.setItem(STORAGE_KEY, advanced ? 'advanced' : 'simple');
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };

  return { advanced: mode === 'advanced', setAdvanced };
}
