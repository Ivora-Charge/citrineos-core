// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useEffect, useState } from 'react';
import { MainMenu, MenuSection } from '@lib/client/components/main-menu/main.menu';
import { ConnectionModal } from '@lib/client/components/modals/shared/connection-modal/connection.modal';
import AppModal from '@lib/client/components/modals';
import { useIsAuthenticated, useOne, useTranslate, useGetIdentity } from '@refinedev/core';
import { usePathname, useRouter } from 'next/navigation';
import type { KeycloakUserIdentity } from '@lib/providers/auth-provider/keycloak-auth-provider';
import { Loader2 } from 'lucide-react';
import { heading2Style } from '@lib/client/styles/page';
import { HeaderBanner } from '@lib/client/components/ui/header-banner';
import { ResourceType } from '@lib/utils/access.types';
import { useTenantId } from '@lib/client/hooks/useTenantId';
import { TENANT_GET_QUERY } from '@lib/queries/tenants';

const ONBOARDING_PATH = '/onboarding';

type AuthenticatedLayoutProps = {
  children: React.ReactNode;
  authKey: string;
  fallback?: React.ReactNode;
};

export default function AuthenticatedLayout({
  children,
  authKey,
  fallback,
}: AuthenticatedLayoutProps) {
  const pathname = usePathname();
  const router = useRouter();
  const translate = useTranslate();
  const [showFirstLoginModal, setShowFirstLoginModal] = useState(false);

  const { data, isLoading } = useIsAuthenticated();
  const { data: identity } = useGetIdentity<KeycloakUserIdentity>();

  // Onboarding gate: a tenant whose paymentOnboardingCompletedAt is unset is
  // redirected to the onboarding wizard. The wizard route itself is exempt to
  // avoid a redirect loop.
  const tenantId = useTenantId();
  const {
    query: { data: tenantData, isLoading: tenantLoading },
  } = useOne<any>({
    resource: ResourceType.TENANTS,
    id: tenantId,
    meta: { gqlQuery: TENANT_GET_QUERY },
    queryOptions: { enabled: data?.authenticated === true },
  });
  const onboardingComplete = !!tenantData?.data?.paymentOnboardingCompletedAt;

  useEffect(() => {
    if (
      data?.authenticated &&
      !tenantLoading &&
      tenantData &&
      !onboardingComplete &&
      pathname !== ONBOARDING_PATH
    ) {
      router.replace(ONBOARDING_PATH);
    }
  }, [data, tenantLoading, tenantData, onboardingComplete, pathname, router]);

  // First login detection logic
  useEffect(() => {
    if (data?.authenticated && identity?.id) {
      const firstLoginKey = `firstLoginHelp:${identity.id}`;
      const hasSeenFirstLoginModal = localStorage.getItem(firstLoginKey);

      if (!hasSeenFirstLoginModal) {
        setShowFirstLoginModal(true);
        localStorage.setItem(firstLoginKey, 'true');
      }
    }
  }, [data, identity]);

  const handleFirstLoginModalClose = () => {
    setShowFirstLoginModal(false);
  };

  useEffect(() => {
    if (!isLoading && data?.authenticated === false) {
      console.log('Redirecting to login...');
      router.push('/login');
    }
  }, [isLoading, data, router]);

  // Determine active section from pathname
  const activeSection = pathname?.split('/')[1] || 'overview';

  // Determine route class name
  const routeClassName = pathname?.replace(/\//g, '-').substring(1) || 'root';

  // Show loading state
  if (isLoading) {
    return (
      fallback || (
        <div className="flex min-h-screen items-center justify-center">
          <div className="flex items-center gap-2 text-center">
            <h2 className={heading2Style}>{translate('pages.checkingAuth')}</h2>
            <Loader2 className="size-8 animate-spin text-primary" />
          </div>
        </div>
      )
    );
  }

  // Show loading while redirecting
  if (!data?.authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-2 text-center">
          <h2 className={heading2Style}>{translate('pages.redirectingToLogin')}</h2>
          <Loader2 className="size-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="min-h-screen ml-20 bg-cover bg-[url(/gradient.svg)] dark:bg-[url(/gradient-dark.svg)]">
        <MainMenu activeSection={activeSection as MenuSection} />
        <div className="flex flex-col">
          <AppModal />
          <main className={`content-container ${routeClassName}`}>
            <div className="content-outer-wrap">
              <div className="content-inner-wrap">
                <>
                  <HeaderBanner />
                  {children}
                </>
              </div>
            </div>
          </main>
        </div>
      </div>
      <ConnectionModal
        open={showFirstLoginModal}
        onClose={handleFirstLoginModalClose}
        isFirstLogin={true}
      />
    </div>
  );
}
