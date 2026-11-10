import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const DEVICE_ADMIN_PERMISSION = 'device_admin_permission';

@Injectable()
export class DeviceAdminPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string>(
      DEVICE_ADMIN_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest();
    const permissions: unknown = request.permissions;
    const sharedSecretTokenIsScoped = request.authMode !== 'dev-secret' || request.tokenUse === 'device_admin';

    if (!required || !sharedSecretTokenIsScoped || !Array.isArray(permissions) ||
        !permissions.some((permission) => permission === required)) {
      throw new ForbiddenException({
        code: 'DEVICE_ADMIN_PERMISSION_REQUIRED',
        message: 'The authenticated identity lacks the required device-management permission.',
      });
    }
    return true;
  }
}
