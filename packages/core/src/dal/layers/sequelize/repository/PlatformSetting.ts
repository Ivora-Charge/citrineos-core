// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { IPlatformSettingRepository } from '../../../interfaces/repositories.js';
import { PlatformSetting } from '../model/PlatformSetting.js';
import { SequelizeRepository, type SequelizeRepositoryDependencies } from './Base.js';

/**
 * PlatformSettings is global (no tenantId), so the tenant-scoped CRUD helpers
 * on the base class are not used; the two accessors below query the model
 * directly.
 */
export class SequelizePlatformSettingRepository
  extends SequelizeRepository<PlatformSetting>
  implements IPlatformSettingRepository
{
  constructor({ config, logger, sequelizeInstance }: SequelizeRepositoryDependencies) {
    super({ config, namespace: PlatformSetting.MODEL_NAME, logger, sequelizeInstance });
  }

  async getValue(key: string): Promise<string | null> {
    const row = await PlatformSetting.findByPk(key);
    return row?.value ?? null;
  }

  async getAll(): Promise<Record<string, string | null>> {
    const rows = await PlatformSetting.findAll();
    return Object.fromEntries(rows.map((r) => [r.key, r.value ?? null]));
  }
}

export default SequelizePlatformSettingRepository;
