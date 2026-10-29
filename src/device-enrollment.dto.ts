import { BadRequestException } from '@nestjs/common';

const ACTIVATION_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const DEVICE_NAME_MAX = 120;
const HOSTNAME_MAX = 255;
const PLATFORM_MAX = 40;
const ARCH_MAX = 40;
const OS_RELEASE_MAX = 100;

export interface HardwareInfoDto {
  hostname: string;
  platform: string;
  arch: string;
  osRelease?: string;
}

export interface EnrollDeviceDto {
  activationCode: string;
  deviceName: string;
  hardwareInfo: HardwareInfoDto;
}

/** Runtime validation without adding a second validation framework to the API. */
export function parseEnrollDeviceDto(input: unknown): EnrollDeviceDto {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('Un objet JSON est requis.');
  }

  const value = input as Record<string, unknown>;
  const activationCode = typeof value.activationCode === 'string'
    ? value.activationCode.trim().toUpperCase()
    : '';
  const deviceName = typeof value.deviceName === 'string' ? value.deviceName.trim() : '';
  const hardware = value.hardwareInfo;

  if (!ACTIVATION_CODE_RE.test(activationCode)) {
    throw new BadRequestException("Le code d'activation doit respecter le format XXXX-XXXX.");
  }
  if (!deviceName || deviceName.length > DEVICE_NAME_MAX) {
    throw new BadRequestException('deviceName doit contenir entre 1 et 120 caractères.');
  }
  if (!hardware || typeof hardware !== 'object' || Array.isArray(hardware)) {
    throw new BadRequestException('hardwareInfo est requis.');
  }

  const info = hardware as Record<string, unknown>;
  const requiredFields: Array<[keyof HardwareInfoDto, number]> = [
    ['hostname', HOSTNAME_MAX],
    ['platform', PLATFORM_MAX],
    ['arch', ARCH_MAX],
  ];
  for (const [field, max] of requiredFields) {
    if (typeof info[field] !== 'string' || !(info[field] as string).trim() ||
        (info[field] as string).trim().length > max) {
      throw new BadRequestException(`hardwareInfo.${field} est requis (maximum ${max} caractères).`);
    }
  }
  if (info.osRelease !== undefined &&
      (typeof info.osRelease !== 'string' || info.osRelease.length > OS_RELEASE_MAX)) {
    throw new BadRequestException('hardwareInfo.osRelease doit être une chaîne de 100 caractères maximum.');
  }

  return {
    activationCode,
    deviceName,
    hardwareInfo: {
      hostname: (info.hostname as string).trim(),
      platform: (info.platform as string).trim(),
      arch: (info.arch as string).trim(),
      ...(typeof info.osRelease === 'string' && info.osRelease.trim()
        ? { osRelease: info.osRelease.trim() }
        : {}),
    },
  };
}
