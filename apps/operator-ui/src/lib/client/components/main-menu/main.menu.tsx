// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import { Logo } from '@lib/client/components/title';
import { cn } from '@lib/utils/cn';
import {
  ArrowLeftRight,
  Building2,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  EvCharger,
  HelpCircle,
  Home,
  MapPin,
  Receipt,
  Users,
  Wrench,
  SlidersHorizontal,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@lib/client/components/ui/button';
import { sidebarIconSize } from '@lib/client/styles/icon';
import { ThemeToggle } from '@lib/client/components/theme-toggle';
import { LocaleSwitcher } from '@lib/client/components/locale-switcher';
import { ConnectionModal } from '@lib/client/components/modals/shared/connection-modal/connection.modal';
import { LogoutButton } from '@lib/client/components/logout-button';
import { useCan, useTranslate } from '@refinedev/core';
import { ActionType, ResourceType } from '@lib/utils/access.types';
import { useUiMode } from '@lib/client/hooks/useUiMode';
import { Switch } from '@lib/client/components/ui/switch';

export enum MenuSection {
  OVERVIEW = 'overview',
  LOCATIONS = 'locations',
  CHARGING_STATIONS = 'charging-stations',
  AUTHORIZATIONS = 'authorizations',
  TRANSACTIONS = 'transactions',
  TARIFFS = 'tariffs',
  PARTNERS = 'partners',
  TENANTS = 'tenants',
  FLEET = 'fleet',
  SETTINGS = 'settings',
}

export interface MainMenuProps {
  activeSection: MenuSection;
}

interface MenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
}

export const MainMenu = ({ activeSection }: MainMenuProps) => {
  const [collapsed, setCollapsed] = useState(true);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const menuRef = useRef<HTMLElement>(null);
  const translate = useTranslate();

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setCollapsed(true);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Platform-staff-only entry: hidden for tenant users (see PLATFORM_ONLY in
  // the access provider).
  const { data: canListTenants } = useCan({
    resource: ResourceType.TENANTS,
    action: ActionType.LIST,
  });
  const { data: canManageBusiness } = useCan({
    resource: ResourceType.TENANTS,
    action: ActionType.EDIT,
  });
  const { data: canViewPlatform } = useCan({
    resource: ResourceType.PLATFORM_SETTINGS,
    action: ActionType.SHOW,
  });

  // Simple mode (the default) is the tenant-operator surface: chargers,
  // sessions, pricing, business. Everything topology/OCPP/roaming lives
  // behind the Advanced toggle -- see useUiMode.
  const { advanced, setAdvanced } = useUiMode();

  const mainMenuItems: MenuItem[] = [
    {
      key: `/${MenuSection.OVERVIEW}`,
      label: translate('menu.overview'),
      icon: <Home className={sidebarIconSize} />,
    },
    ...(advanced
      ? [
          {
            key: `/${MenuSection.LOCATIONS}`,
            label: translate('Locations.Locations'),
            icon: <MapPin className={sidebarIconSize} />,
          },
        ]
      : []),
    {
      key: `/${MenuSection.CHARGING_STATIONS}`,
      label: advanced ? translate('ChargingStations.ChargingStations') : 'Chargers',
      icon: <EvCharger className={sidebarIconSize} />,
    },
    ...(advanced
      ? [
          {
            key: `/${MenuSection.AUTHORIZATIONS}`,
            label: translate('Authorizations.Authorizations'),
            icon: <Clipboard className={sidebarIconSize} />,
          },
        ]
      : []),
    {
      key: `/${MenuSection.TRANSACTIONS}`,
      label: advanced ? translate('Transactions.Transactions') : 'Sessions',
      icon: <ArrowLeftRight className={sidebarIconSize} />,
    },
    {
      key: `/${MenuSection.TARIFFS}`,
      label: advanced ? translate('Tariffs.Tariffs') : 'Pricing',
      icon: <Receipt className={sidebarIconSize} />,
    },
    ...(advanced
      ? [
          {
            key: `/${MenuSection.PARTNERS}`,
            label: translate('TenantPartners.TenantPartners'),
            icon: <Users className={sidebarIconSize} />,
          },
        ]
      : []),
    ...(advanced && canListTenants?.can
      ? [
          {
            key: `/${MenuSection.TENANTS}`,
            label: 'Tenants',
            icon: <Building2 className={sidebarIconSize} />,
          },
          {
            key: `/${MenuSection.FLEET}`,
            label: 'Fleet',
            icon: <EvCharger className={sidebarIconSize} />,
          },
        ]
      : []),
    ...(canManageBusiness?.can
      ? [
          {
            key: `/${MenuSection.SETTINGS}/business`,
            label: 'Business',
            icon: <Building2 className={sidebarIconSize} />,
          },
        ]
      : []),
    // Platform-wide configuration: platform staff only (same gate as Tenants),
    // shown in simple mode too so admins can reach it without the toggle.
    ...(canViewPlatform?.can
      ? [
          {
            key: `/${MenuSection.SETTINGS}/platform`,
            label: 'Platform',
            icon: <SlidersHorizontal className={sidebarIconSize} />,
          },
        ]
      : []),
  ];

  return (
    <>
      <aside
        className={cn(
          'fixed left-0 top-0 h-screen bg-card transition-all duration-300 z-40 flex flex-col shadow-md',
          collapsed ? 'w-20' : 'w-[272px]',
        )}
        ref={menuRef}
      >
        {/* Logo Section */}
        <div className="min-h-[130px] flex items-center justify-center px-4">
          <Logo collapsed={collapsed} />
        </div>

        {/* Main Navigation */}
        <nav className="flex-1 overflow-y-auto py-2">
          <ul className="space-y-1 px-3">
            {mainMenuItems.map((item) => {
              const isActive = `/${activeSection}` === item.key;
              return (
                <li key={item.key}>
                  <Link
                    href={item.key}
                    className={cn(
                      'flex items-center gap-3 px-3 py-3 rounded-md transition-colors text-sm',
                      'hover:bg-accent hover:text-accent-foreground',
                      isActive
                        ? 'bg-accent text-accent-foreground font-medium'
                        : 'text-muted-foreground',
                      collapsed && 'justify-center px-2',
                    )}
                    title={collapsed ? item.label : undefined}
                  >
                    <span className="shrink-0">{item.icon}</span>
                    {!collapsed && <span>{item.label}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Bottom Menu - Help Link */}
        <div className="border-t border-border p-3 flex flex-col gap-2 items-center">
          <div
            className={cn(
              'flex items-center gap-2 py-2 text-sm text-muted-foreground',
              collapsed && 'flex-col gap-1',
            )}
            title="Advanced mode: locations, authorizations, roaming partners, EVSE/connector topology, OCPP logs and configuration"
          >
            <Wrench className={sidebarIconSize} />
            {!collapsed && <span>Advanced</span>}
            <Switch checked={advanced} onCheckedChange={setAdvanced} aria-label="Advanced mode" />
          </div>
          <ThemeToggle expanded={!collapsed} />
          <LocaleSwitcher expanded={!collapsed} />
          <Button
            variant="ghost"
            onClick={() => setIsHelpOpen(true)}
            title={translate('menu.help')}
          >
            <HelpCircle className={sidebarIconSize} />
            {!collapsed && <span>{translate('menu.help')}</span>}
          </Button>
          <LogoutButton expanded={!collapsed} />
        </div>

        {/* Collapse Toggle */}
        <Button
          variant="link"
          onClick={() => setCollapsed(!collapsed)}
          className="absolute top-0 right-0 transform translate-x-1/2 translate-y-[110px] size-8 bg-card text-accent-foreground border-transparent rounded-full shadow-md"
          aria-label={
            collapsed ? translate('menu.expandSidebar') : translate('menu.collapseSidebar')
          }
        >
          {collapsed ? (
            <ChevronRight className={sidebarIconSize} />
          ) : (
            <ChevronLeft className={sidebarIconSize} />
          )}
        </Button>
      </aside>
      <ConnectionModal open={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
    </>
  );
};
