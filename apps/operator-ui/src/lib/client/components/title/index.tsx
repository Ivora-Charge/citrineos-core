// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import config from '@lib/utils/config';
import { motion } from 'framer-motion';
import React from 'react';
import Image from 'next/image';

export interface LogoProps {
  collapsed?: boolean;
}

// Ivora Charge lockup: elephant mark + serif wordmark, matching
// ivoracharge.com and the driver payment page (frontend/src/components/Logo.js).
const serifStack =
  "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif";

export const Logo: React.FC<LogoProps> = (props: LogoProps) => {
  const { collapsed = false } = props;

  // The logo takes the user back to the Ivora launcher (the analytics home
  // page with one tile per product) when NEXT_PUBLIC_LAUNCHER_URL is set;
  // otherwise to this app's overview. Same sign-in either way (shared SSO
  // cookie), so it is a plain link.
  return (
    <a
      href={config.launcherUrl || '/overview'}
      title={config.launcherUrl ? 'Back to the Ivora launcher' : 'Overview'}
      className="flex h-full w-full items-center justify-center gap-2.5"
    >
      <Image
        src="/ivora-mark.png"
        alt={`${config.appName} Logo`}
        width={collapsed ? 40 : 36}
        height={collapsed ? 40 : 36}
        priority
      />
      {!collapsed && (
        <motion.span
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          className="whitespace-nowrap text-xl font-semibold leading-none text-foreground"
          style={{ fontFamily: serifStack, letterSpacing: '-0.01em' }}
        >
          Ivora
          <span className="ml-1.5 font-normal text-muted-foreground">Charge</span>
        </motion.span>
      )}
    </a>
  );
};
