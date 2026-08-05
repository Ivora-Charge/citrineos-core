// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Public self-signup page: creates an organization (tenant) and its first
 * tenant-admin via selfSignupAction, then tells the user to check their inbox
 * for the verification link. Deliberately outside the authenticated app shell
 * (see middleware matcher).
 */

import React from 'react';

import { Button } from '@lib/client/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
} from '@lib/client/components/ui/card';
import { Input } from '@lib/client/components/ui/input';
import { Label } from '@lib/client/components/ui/label';
import {
  selfSignupAction,
  type SelfSignupInput,
} from '@lib/server/actions/selfSignup';

export default function SignupPage() {
  const [form, setForm] = React.useState<SelfSignupInput>({
    organization: '',
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    website: '',
  });
  const [submitting, setSubmitting] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = (key: keyof SelfSignupInput) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.organization.trim().length < 2) {
      setError('Enter your organization name.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    if (form.password.length < 10) {
      setError('Choose a password of at least 10 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await selfSignupAction(form);
      if (result.success) setDone(true);
      else setError(result.error);
    } catch {
      setError('Sign-up failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-muted/40">
      <Card className="w-full max-w-md">
        <CardHeader>
          <h1 className="text-xl font-semibold">
            Create your Ivora Charge account
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage your chargers, pricing and payouts.
          </p>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-2">
              <p className="font-medium">Check your inbox</p>
              <p className="text-sm text-muted-foreground">
                We sent a verification link to{' '}
                <span className="font-medium">{form.email}</span>. Click it to
                activate your account, then sign in.
              </p>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="organization">Organization</Label>
                <Input
                  id="organization"
                  placeholder="Acme Charging LLC"
                  maxLength={100}
                  value={form.organization}
                  onChange={set('organization')}
                  required
                />
              </div>
              <div className="flex gap-3">
                <div className="space-y-2 flex-1">
                  <Label htmlFor="firstName">First name</Label>
                  <Input
                    id="firstName"
                    autoComplete="given-name"
                    value={form.firstName}
                    onChange={set('firstName')}
                  />
                </div>
                <div className="space-y-2 flex-1">
                  <Label htmlFor="lastName">Last name</Label>
                  <Input
                    id="lastName"
                    autoComplete="family-name"
                    value={form.lastName}
                    onChange={set('lastName')}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={form.email}
                  onChange={set('email')}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  This becomes your login.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={set('password')}
                  required
                  minLength={10}
                />
              </div>
              {/* Honeypot: hidden from humans; bots that fill it are dropped. */}
              <div className="absolute -left-[9999px] -top-[9999px]" aria-hidden>
                <Input
                  id="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={form.website}
                  onChange={set('website')}
                />
              </div>

              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? 'Creating account…' : 'Sign up'}
              </Button>
              <p className="text-sm text-muted-foreground">
                Already have an account?{' '}
                <a href="/login" className="font-medium underline">
                  Sign in
                </a>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
