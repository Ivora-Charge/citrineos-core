// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import type {
  CallAction,
  ClearMessageStatusEnumType,
  HandlerProperties,
  IMessage,
  IMessageConfirmation,
  IWebsocketConnection,
  OcppModuleDependencies,
  OCPP2_common_types,
  OCPP2_request_types,
  OCPP2_response_types,
  RegistrationStatusEnumType,
} from '@citrineos/base';
import {
  AbstractModule,
  AsHandler,
  BOOT_STATUS,
  CacheNamespace,
  ChargingStationSequenceTypeEnum,
  ClearMessageStatusEnum,
  createIdentifier,
  DataTransferStatusEnum,
  DisplayMessageStatusEnum,
  ErrorCode,
  EventGroup,
  MessageOrigin,
  MessageState,
  Namespace,
  OCPP1_6,
  OCPP_2_VER_LIST,
  OCPP_CallAction,
  OcppError,
  OCPPVersion,
  RegistrationStatusEnum,
  ResetEnum,
  SetNetworkProfileStatusEnum,
  SetVariableStatusEnum,
  type DisplayMessageStatusEnumType,
} from '@citrineos/base';

import type {
  IBootRepository,
  IChangeConfigurationRepository,
  IDeviceModelRepository,
  ILocationRepository,
  IMessageInfoRepository,
  IOCPPMessageRepository,
  IPlatformSettingRepository,
  ITenantRepository,
} from '@dal/interfaces/repositories.js';
import {
  Boot,
  ChangeConfiguration,
  ChargingStation,
  PlatformSettingKey,
  ChargingStationNetworkProfile,
  Component,
  ServerNetworkProfile,
  SetNetworkProfile,
} from '@dal/layers/sequelize/index.js';
import { IdGenerator, validateMessageContentType } from '@util/index.js';
import { v4 as uuidv4 } from 'uuid';

import type { BootNotificationService } from './BootNotificationService.js';
import type { DeviceModelService } from './DeviceModelService.js';

export interface ConfigurationModuleDependencies extends OcppModuleDependencies {
  bootRepository: IBootRepository;
  deviceModelRepository: IDeviceModelRepository;
  messageInfoRepository: IMessageInfoRepository;
  locationRepository: ILocationRepository;
  changeConfigurationRepository: IChangeConfigurationRepository;
  ocppMessageRepository: IOCPPMessageRepository;
  /** Optional so existing test harnesses that build the module by hand keep working. */
  platformSettingRepository?: IPlatformSettingRepository;
  idGenerator: IdGenerator;
  tenantRepository: ITenantRepository;
  configurationDeviceModelService: DeviceModelService;
  bootNotificationService: BootNotificationService;
}

/**
 * Component that handles Configuration related messages.
 */
export class ConfigurationModule extends AbstractModule {
  public _deviceModelService: DeviceModelService;

  _requests: CallAction[] = [];

  _responses: CallAction[] = [];
  protected _bootService: BootNotificationService;
  private _idGenerator: IdGenerator;

  constructor({
    config,
    cache,
    sender,
    handler,
    logger,
    ocppValidator,
    bootRepository,
    deviceModelRepository,
    messageInfoRepository,
    locationRepository,
    changeConfigurationRepository,
    ocppMessageRepository,
    platformSettingRepository,
    idGenerator,
    tenantRepository,
    configurationDeviceModelService,
    bootNotificationService,
  }: ConfigurationModuleDependencies) {
    super(config, cache, handler, sender, EventGroup.Configuration, logger, ocppValidator);

    this._requests = config.modules.configuration.requests;
    this._responses = config.modules.configuration.responses;

    this._bootRepository = bootRepository;
    this._deviceModelRepository = deviceModelRepository;
    this._messageInfoRepository = messageInfoRepository;
    this._locationRepository = locationRepository;
    this._changeConfigurationRepository = changeConfigurationRepository;
    this._ocppMessageRepository = ocppMessageRepository;
    this._platformSettingRepository = platformSettingRepository;
    this._tenantRepository = tenantRepository;

    this._deviceModelService = configurationDeviceModelService;
    this._bootService = bootNotificationService;

    this._idGenerator = idGenerator;
  }

  protected _tenantRepository: ITenantRepository;

  get tenantRepository(): ITenantRepository {
    return this._tenantRepository;
  }

  protected _bootRepository: IBootRepository;

  get bootRepository(): IBootRepository {
    return this._bootRepository;
  }

  protected _deviceModelRepository: IDeviceModelRepository;

  get deviceModelRepository(): IDeviceModelRepository {
    return this._deviceModelRepository;
  }

  protected _messageInfoRepository: IMessageInfoRepository;

  get messageInfoRepository(): IMessageInfoRepository {
    return this._messageInfoRepository;
  }

  protected _locationRepository: ILocationRepository;

  get locationRepository(): ILocationRepository {
    return this._locationRepository;
  }

  protected _changeConfigurationRepository: IChangeConfigurationRepository;

  protected _platformSettingRepository?: IPlatformSettingRepository;

  /**
   * Seconds between periodic MeterValues when a station row does not exist yet
   * and PlatformSettings.defaultMeterValueSampleInterval is unset.
   */
  static readonly DEFAULT_METER_VALUE_SAMPLE_INTERVAL = 20;

  get changeConfigurationRepository(): IChangeConfigurationRepository {
    return this._changeConfigurationRepository;
  }

  protected _ocppMessageRepository: IOCPPMessageRepository;

  get ocppMessageRepository(): IOCPPMessageRepository {
    return this._ocppMessageRepository;
  }

  /**
   * Handle OCPP 2.X requests
   */

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.BootNotification)
  protected async _handleBootNotification(
    message: IMessage<OCPP2_request_types.BootNotificationRequest>,
    props?: HandlerProperties,
  ): Promise<void> {
    this._logger.debug('BootNotification received:', message, props);

    const ocppConnectionName = message.context.ocppConnectionName;
    const tenantId = message.context.tenantId;
    const timestamp = message.context.timestamp;
    const chargingStation = message.payload.chargingStation;

    const bootNotificationResponse: OCPP2_response_types.BootNotificationResponse =
      await this._bootService.createBootNotificationResponse(tenantId, ocppConnectionName);

    // Check cached boot status for charger. Only Pending and Rejected statuses are cached.
    const cachedBootStatus: RegistrationStatusEnumType | null = await this._cache.get(
      BOOT_STATUS,
      ocppConnectionName,
    );

    // Blacklist or whitelist charger actions in cache
    await this._bootService.cacheChargerActionsPermissions(
      ocppConnectionName,
      cachedBootStatus,
      bootNotificationResponse.status,
    );

    const bootNotificationResponseMessageConfirmation: IMessageConfirmation =
      await this.sendCallResultWithMessage(message, bootNotificationResponse);

    // Update charging station first, then device model.
    // Order matters: updateDeviceModel creates VariableAttributes with a FK
    // reference to the ChargingStation record, so the station must exist first.
    (async () => {
      const connectionJson = await this._cache.get<string>(
        createIdentifier(tenantId, ocppConnectionName),
        CacheNamespace.Connections,
      );
      const connection: IWebsocketConnection | null = connectionJson
        ? JSON.parse(connectionJson)
        : null;
      if (!connection?.allowUnknownChargingStations) {
        const exists = await this._locationRepository.doesChargingStationExistByStationId(
          tenantId,
          ocppConnectionName,
        );
        if (!exists) {
          throw new Error(
            `Charging station ${ocppConnectionName} does not exist and allowUnknownChargingStations is false`,
          );
        }
      }
      await this._locationRepository.createOrUpdateChargingStation(
        tenantId,
        ChargingStation.build({
          tenantId,
          ocppConnectionName,
          chargePointVendor: chargingStation.vendorName,
          chargePointModel: chargingStation.model,
          chargePointSerialNumber: chargingStation.serialNumber,
          firmwareVersion: chargingStation.firmwareVersion,
          iccid: chargingStation.modem?.iccid,
          imsi: chargingStation.modem?.imsi,
        }),
      );
      // The router stamps isOnline/protocol at websocket-upgrade time, but a
      // never-seen charger has no ChargingStations row at that moment (this
      // boot just created it), so that stamp was skipped and the station
      // would show offline (and protocol-dependent behavior would misroute)
      // until its next reconnect. Re-stamp now that the row exists.
      await this._locationRepository.setChargingStationIsOnlineAndOCPPVersion(
        tenantId,
        ocppConnectionName,
        true,
        (message.protocol as OCPPVersion) ?? null,
      );
      await this._deviceModelService.updateDeviceModel(
        chargingStation,
        tenantId,
        ocppConnectionName,
        timestamp,
      );
    })().catch((error) => {
      this._logger.error(
        `Error updating station ${ocppConnectionName} or device model with boot info:`,
        error,
      );
    });

    if (!bootNotificationResponseMessageConfirmation.success) {
      throw new Error('BootNotification failed: ' + bootNotificationResponseMessageConfirmation);
    }

    if (
      bootNotificationResponse.status !== RegistrationStatusEnum.Accepted &&
      (!cachedBootStatus || bootNotificationResponse.status !== cachedBootStatus)
    ) {
      // Cache boot status for charger if (not accepted) and ((not already cached) or (different status from cached status)).
      await this._cache.set(BOOT_STATUS, bootNotificationResponse.status, ocppConnectionName);
    }

    // Update charger-specific boot config with details of most recently sent BootNotificationResponse
    const bootConfigDbEntity: Boot = await this._bootService.updateBootConfig(
      bootNotificationResponse,
      tenantId,
      ocppConnectionName,
    );

    // Ivora: every accepted boot re-applies the station's meter sampling interval
    // (SampledDataCtrlr.TxUpdatedInterval), see _pushMeterValueSampleInterval.
    if (bootNotificationResponse.status === RegistrationStatusEnum.Accepted) {
      this._pushMeterValueSampleInterval(
        tenantId,
        ocppConnectionName,
        (message.protocol as OCPPVersion) ?? OCPPVersion.OCPP2_0_1,
      ).catch((error) =>
        this._logger.warn(
          `Failed to push TxUpdatedInterval to ${ocppConnectionName} after boot:`,
          error,
        ),
      );
    }

    // If boot notification is not pending, do not start configuration.
    // If cached boot status is not null and pending, configuration is already in progress - do not start configuration again.
    if (
      bootNotificationResponse.status !== RegistrationStatusEnum.Pending ||
      (cachedBootStatus && cachedBootStatus === RegistrationStatusEnum.Pending)
    ) {
      return;
    }

    // GetBaseReport
    // TODO Consider refactoring GetBaseReport and SetVariables sections as methods to be used by their respective message api endpoints as well
    if (
      bootConfigDbEntity.getBaseReportOnPending ??
      this._config.modules.configuration.ocpp2_0_1?.getBaseReportOnPending
    ) {
      // Remove Notify Report from blacklist
      await this._cache.remove(OCPP_CallAction.NotifyReport, ocppConnectionName);

      const getBaseReportRequest = await this._bootService.createGetBaseReportRequest(
        ocppConnectionName,
        this._config.maxCachingSeconds,
      );

      const getBaseReportConfirmation = await this.sendCall(
        ocppConnectionName,
        tenantId,
        message.protocol,
        OCPP_CallAction.GetBaseReport,
        getBaseReportRequest,
      );

      await this._bootService.confirmGetBaseReportSuccess(
        ocppConnectionName,
        getBaseReportRequest.requestId.toString(),
        getBaseReportConfirmation,
        this._config.maxCachingSeconds,
      );

      // Make sure GetBaseReport doesn't re-trigger on next boot attempt
      bootConfigDbEntity.getBaseReportOnPending = false;
      await bootConfigDbEntity.save();
    }

    // SetVariables
    let rejectedSetVariable = false;
    let rebootSetVariable = false;
    if (
      bootConfigDbEntity.pendingBootSetVariables &&
      bootConfigDbEntity.pendingBootSetVariables.length > 0
    ) {
      bootConfigDbEntity.variablesRejectedOnLastBoot = [];

      let setVariableData: OCPP2_common_types.SetVariableDataType[] =
        await this._deviceModelRepository.readAllSetVariableByStationId(
          tenantId,
          ocppConnectionName,
        );

      // If ItemsPerMessageSetVariables not set, send all variables at once
      const itemsPerMessageSetVariables =
        (await this._deviceModelService.getItemsPerMessageSetVariablesByStationId(
          tenantId,
          ocppConnectionName,
        )) ?? setVariableData.length;

      while (setVariableData.length > 0) {
        const correlationId = uuidv4();

        const cacheCallbackPromise: Promise<string | null> = this._cache.onChange(
          correlationId,
          this._config.maxCachingSeconds,
          ocppConnectionName,
        ); // x2 fudge factor for any network lag

        await this.sendCall(
          ocppConnectionName,
          tenantId,
          message.protocol,
          OCPP_CallAction.SetVariables,
          {
            setVariableData: setVariableData.slice(0, itemsPerMessageSetVariables),
          } as OCPP2_request_types.SetVariablesRequest,
          undefined,
          correlationId,
        );

        setVariableData = setVariableData.slice(itemsPerMessageSetVariables);

        const setVariablesResponseJsonString = await cacheCallbackPromise;

        if (setVariablesResponseJsonString) {
          if (rejectedSetVariable && rebootSetVariable) {
            continue;
          }

          const setVariablesResponse: OCPP2_response_types.SetVariablesResponse = JSON.parse(
            setVariablesResponseJsonString,
          );
          setVariablesResponse.setVariableResult.forEach((result) => {
            if (result.attributeStatus === SetVariableStatusEnum.Rejected) {
              rejectedSetVariable = true;
            } else if (result.attributeStatus === SetVariableStatusEnum.RebootRequired) {
              rebootSetVariable = true;
            }
          });
        } else {
          throw new Error('SetVariables response not found');
        }
      }

      const doNotBootWithRejectedVariables = !(
        (
          bootConfigDbEntity.bootWithRejectedVariables ??
          this._config.modules.configuration.ocpp2_0_1?.bootWithRejectedVariables
        ) //TODO: When we add 2.1 config, we will need to adjust this logic to vary by message protocol
      );

      if (rejectedSetVariable && doNotBootWithRejectedVariables) {
        bootConfigDbEntity.status = RegistrationStatusEnum.Rejected;
        await bootConfigDbEntity.save();
        // No more to do.
        return;
      }
    }

    if (this._config.modules.configuration.ocpp2_0_1?.autoAccept) {
      //TODO: When we add 2.1 config, we will need to adjust this logic to vary by message protocol
      // Update boot config with status accepted
      // TODO: Determine how/if StatusInfo should be generated
      bootConfigDbEntity.status = RegistrationStatusEnum.Accepted;
      await bootConfigDbEntity.save();
    }

    if (rebootSetVariable) {
      // Charger SHALL not be in a transaction as it has not yet successfully booted, therefore it is appropriate to send an Immediate Reset
      await this.sendCall(ocppConnectionName, tenantId, message.protocol, OCPP_CallAction.Reset, {
        type: ResetEnum.Immediate,
      } as OCPP2_request_types.ResetRequest);
    } else {
      // We could trigger the new boot immediately rather than wait for the retry, as nothing more now needs to be done.
      // However, B02.FR.02 - Spec allows for TriggerMessageRequest - OCTT fails over trigger
      // Commenting out until OCTT behavior changes.
      // this.sendCall(ocppConnectionName, tenantId, OCPPVersion.OCPP2_0_1, OCPP_CallAction.TriggerMessage,
      //   { requestedMessage: MessageTriggerEnumType.BootNotification } as TriggerMessageRequest);
    }
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.Heartbeat)
  protected async _handleHeartbeat(
    message: IMessage<OCPP2_request_types.HeartbeatRequest>,
    props?: HandlerProperties,
  ): Promise<void> {
    this._logger.debug('Heartbeat received:', message, props);

    // Create response
    const response: OCPP2_response_types.HeartbeatResponse = {
      currentTime: new Date().toISOString(),
    };

    const messageConfirmation = await this.sendCallResultWithMessage(message, response);
    this._logger.debug('Heartbeat response sent: ', messageConfirmation);
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.NotifyDisplayMessages)
  protected async _handleNotifyDisplayMessages(
    message: IMessage<OCPP2_request_types.NotifyDisplayMessagesRequest>,
    props?: HandlerProperties,
  ): Promise<void> {
    // Validate requestId was provided in a previous GetDisplayMessagesRequest
    const requestId = message.payload.requestId;
    const previousRequest = await this._ocppMessageRepository.readAllByQuery(
      message.context.tenantId,
      {
        where: {
          tenantId: message.context.tenantId,
          ocppConnectionName: message.context.ocppConnectionName,
          action: OCPP_CallAction.GetDisplayMessages,
          message: {
            requestId: requestId,
          },
        },
        limit: 1,
      },
      Namespace.OCPPMessage,
    );

    if (!previousRequest || previousRequest.length === 0) {
      await this.sendCallErrorWithMessage(
        message,
        new OcppError(
          message.context.correlationId,
          ErrorCode.PropertyConstraintViolation,
          'RequestId was not provided in a GetDisplayMessagesRequest.',
        ),
      );
      return;
    }

    const messageInfoTypes = message.payload.messageInfo as OCPP2_common_types.MessageInfoType[];
    // Validate message content for each messageInfo item
    if (messageInfoTypes && messageInfoTypes.length > 0) {
      const validationErrors: string[] = [];
      for (const messageInfoType of messageInfoTypes) {
        const validationResult = validateMessageContentType(messageInfoType.message);
        if (!validationResult.isValid) {
          validationErrors.push(
            `Message ID ${messageInfoType.id}: ${validationResult.errorMessage}`,
          );
        }
      }
      if (validationErrors.length > 0) {
        const errorMessage = `Message content validation failed: ${validationErrors.join('; ')}`;
        const error = new OcppError(
          message.context.correlationId,
          ErrorCode.PropertyConstraintViolation,
          errorMessage,
        );
        await this.sendCallErrorWithMessage(message, error);
        return;
      }
    }

    this._logger.debug('NotifyDisplayMessages received: ', message, props);

    const tenantId = message.context.tenantId;

    for (const messageInfoType of messageInfoTypes) {
      let componentId: number | undefined;
      if (messageInfoType.display) {
        const component: Component = await this._deviceModelRepository.findOrCreateEvseAndComponent(
          tenantId,
          messageInfoType.display,
          message.context.ocppConnectionName,
        );
        componentId = component.id;
      }
      await this._messageInfoRepository.createOrUpdateByMessageInfoTypeAndStationId(
        tenantId,
        messageInfoType,
        message.context.ocppConnectionName,
        componentId,
      );
    }

    // Create response
    const response: OCPP2_response_types.NotifyDisplayMessagesResponse = {};

    const messageConfirmation = await this.sendCallResultWithMessage(message, response);
    this._logger.debug('NotifyDisplayMessages response sent: ', messageConfirmation);
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.FirmwareStatusNotification)
  protected async _handleFirmwareStatusNotification(
    message: IMessage<OCPP2_request_types.FirmwareStatusNotificationRequest>,
    props?: HandlerProperties,
  ): Promise<void> {
    this._logger.debug('FirmwareStatusNotification received:', message, props);

    // TODO: FirmwareStatusNotification is usually triggered. Ideally, it should be sent to the callbackUrl from the message api that sent the trigger message

    // Validate requestId requirement
    // requestId is mandatory unless message was triggered by TriggerMessageRequest AND no firmware update is ongoing
    if (!message.payload.requestId) {
      await this.sendCallErrorWithMessage(
        message,
        new OcppError(
          message.context.correlationId,
          ErrorCode.OccurrenceConstraintViolation,
          'RequestId is required.',
        ),
      );
      return;
    }

    // Create response
    const response: OCPP2_response_types.FirmwareStatusNotificationResponse = {};

    const messageConfirmation = await this.sendCallResultWithMessage(message, response);
    this._logger.debug('FirmwareStatusNotification response sent: ', messageConfirmation);
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.DataTransfer)
  protected async _handleDataTransfer(
    message: IMessage<OCPP2_request_types.DataTransferRequest>,
    props?: HandlerProperties,
  ): Promise<void> {
    this._logger.debug('DataTransfer received:', message, props);

    if (message.state === MessageState.Request) {
      // Create response
      const response = {
        status: DataTransferStatusEnum.Rejected,
        statusInfo: { reasonCode: ErrorCode.NotImplemented },
      } as OCPP2_response_types.DataTransferResponse;

      const messageConfirmation = await this.sendCallResultWithMessage(message, response);
      this._logger.debug('DataTransfer response sent: ', messageConfirmation);
    } else {
      this._logger.debug('DataTransfer response received:', message, props);
    }
  }

  /**
   * Handle OCPP 2.X responses
   */

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.ChangeAvailability)
  protected _handleChangeAvailability(
    message: IMessage<OCPP2_response_types.ChangeAvailabilityResponse>,
    props?: HandlerProperties,
  ): void {
    this._logger.debug('ChangeAvailability response received:', message, props);
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.SetNetworkProfile)
  protected async _handleSetNetworkProfile(
    message: IMessage<OCPP2_response_types.SetNetworkProfileResponse>,
    props?: HandlerProperties,
  ): Promise<void> {
    this._logger.debug('SetNetworkProfile response received:', message, props);

    if (message.payload.status == SetNetworkProfileStatusEnum.Accepted) {
      const setNetworkProfile = await SetNetworkProfile.findOne({
        where: { tenantId: message.context.tenantId, correlationId: message.context.correlationId },
      });
      if (setNetworkProfile) {
        const serverNetworkProfile = await ServerNetworkProfile.findByPk(
          setNetworkProfile.websocketServerConfigId!,
        );
        if (serverNetworkProfile) {
          const chargingStation = await ChargingStation.findOne({
            where: {
              ocppConnectionName: message.context.ocppConnectionName,
              tenantId: message.context.tenantId,
            },
          });
          if (chargingStation) {
            const [chargingStationNetworkProfile] = await ChargingStationNetworkProfile.findOrBuild(
              {
                where: {
                  tenantId: message.context.tenantId,
                  ocppConnectionName: chargingStation.ocppConnectionName,
                  configurationSlot: setNetworkProfile.configurationSlot!,
                },
              },
            );
            chargingStationNetworkProfile.websocketServerConfigId =
              setNetworkProfile.websocketServerConfigId!;
            chargingStationNetworkProfile.setNetworkProfileId = setNetworkProfile.id;
            await chargingStationNetworkProfile.save();
          }
        }
      }
    }
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.GetDisplayMessages)
  protected _handleGetDisplayMessages(
    message: IMessage<OCPP2_response_types.GetDisplayMessagesResponse>,
    props?: HandlerProperties,
  ): void {
    this._logger.debug('GetDisplayMessages response received:', message, props);
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.SetDisplayMessage)
  protected async _handleSetDisplayMessage(
    message: IMessage<OCPP2_response_types.SetDisplayMessageResponse>,
    props?: HandlerProperties,
  ): Promise<void> {
    this._logger.debug('SetDisplayMessage response received:', message, props);

    const status = message.payload.status as DisplayMessageStatusEnumType;
    // when charger station accepts the set message info request
    // we trigger a get all display messages request to update stored message info in db
    if (status === DisplayMessageStatusEnum.Accepted) {
      await this._messageInfoRepository.deactivateAllByStationId(
        message.context.tenantId,
        message.context.ocppConnectionName,
      );
      await this.sendCall(
        message.context.ocppConnectionName,
        message.context.tenantId,
        message.protocol,
        OCPP_CallAction.GetDisplayMessages,
        {
          requestId: await this._idGenerator.generateRequestId(
            message.context.tenantId,
            message.context.ocppConnectionName,
            ChargingStationSequenceTypeEnum.getDisplayMessages,
          ), //TODO: When we add 2.1 config, we will need to adjust this logic to vary by message protoco
        } as OCPP2_request_types.GetDisplayMessagesRequest,
      );
    }
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.PublishFirmware)
  protected _handlePublishFirmware(
    message: IMessage<OCPP2_response_types.PublishFirmwareResponse>,
    props?: HandlerProperties,
  ): void {
    this._logger.debug('PublishFirmware response received:', message, props);
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.UnpublishFirmware)
  protected _handleUnpublishFirmware(
    message: IMessage<OCPP2_response_types.UnpublishFirmwareResponse>,
    props?: HandlerProperties,
  ): void {
    this._logger.debug('UnpublishFirmware response received:', message, props);
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.UpdateFirmware)
  protected _handleUpdateFirmware(
    message: IMessage<OCPP2_response_types.UpdateFirmwareResponse>,
    props?: HandlerProperties,
  ): void {
    this._logger.debug('UpdateFirmware response received:', message, props);
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.Reset)
  protected _handleReset(
    message: IMessage<OCPP2_response_types.ResetResponse>,
    props?: HandlerProperties,
  ): void {
    this._logger.debug('Reset response received:', message, props);
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.TriggerMessage)
  protected _handleTriggerMessage(
    message: IMessage<OCPP2_response_types.TriggerMessageResponse>,
    props?: HandlerProperties,
  ): void {
    this._logger.debug('TriggerMessage response received:', message, props);
  }

  @AsHandler(OCPP_2_VER_LIST, OCPP_CallAction.ClearDisplayMessage)
  protected async _handleClearDisplayMessage(
    message: IMessage<OCPP2_response_types.ClearDisplayMessageResponse>,
    props?: HandlerProperties,
  ): Promise<void> {
    this._logger.debug('ClearDisplayMessage response received:', message, props);

    const status = message.payload.status as ClearMessageStatusEnumType;
    // when charger station accepts the clear message info request
    // we trigger a get all display messages request to update stored message info in db
    if (status === ClearMessageStatusEnum.Accepted) {
      await this._messageInfoRepository.deactivateAllByStationId(
        message.context.tenantId,
        message.context.ocppConnectionName,
      );
      await this.sendCall(
        message.context.ocppConnectionName,
        message.context.tenantId,
        message.protocol,
        OCPP_CallAction.GetDisplayMessages,
        {
          requestId: await this._idGenerator.generateRequestId(
            message.context.tenantId,
            message.context.ocppConnectionName,
            ChargingStationSequenceTypeEnum.getDisplayMessages,
          ),
        } as OCPP2_request_types.GetDisplayMessagesRequest,
      );
    }
  }

  /**
   * Handle OCPP 1.6 requests
   */

  // RCD/HengTong AC firmware (V72.78) renders its wall clock straight from
  // the OCPP currentTime RTC sync: it stores the vendor zone_offset_req
  // (result 0) but never applies it to the display (verified across warm
  // and cold boots, 2026-08-01). The only way to show local time on these
  // units is to answer their Boot/Heartbeat with LOCAL wall time. This is a
  // deliberate protocol violation scoped to RCD-vendor 1.6 stations: their
  // charger-stamped timestamps (StatusNotification, StartTransaction, ...)
  // arrive shifted by the zone offset. Durations stay correct (both ends
  // shift equally); absolute times in Transactions/OCPPMessages are local-
  // labeled-Z for these stations. OPT-IN: set OCPP16_RCD_LOCAL_TIME_TZ to
  // an IANA zone name to enable; unset => honest UTC for everyone (chosen
  // default 2026-08-01 -- display timezone is being pursued with RCD
  // instead, so transaction timestamps stay clean).
  private _ocpp16LocalTimeVendorCache = new Map<string, boolean>();

  protected static _ocpp16LocalTimeZone(): string | null {
    const tz = process.env.OCPP16_RCD_LOCAL_TIME_TZ ?? '';
    return tz && tz !== 'off' ? tz : null;
  }

  protected static _localWallTimeAsIso(tz: string): string {
    const now = new Date();
    try {
      const atTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const atUtc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
      return new Date(now.getTime() + atTz.getTime() - atUtc.getTime()).toISOString();
    } catch {
      return now.toISOString();
    }
  }

  protected async _ocpp16CurrentTime(tenantId: number, stationId: string): Promise<string> {
    const tz = ConfigurationModule._ocpp16LocalTimeZone();
    if (!tz) {
      return new Date().toISOString();
    }
    const key = `${tenantId}:${stationId}`;
    let isRcd = this._ocpp16LocalTimeVendorCache.get(key);
    if (isRcd === undefined) {
      try {
        const station = await this._locationRepository.readChargingStationByStationId(
          tenantId,
          stationId,
        );
        if (!station) {
          return new Date().toISOString(); // not booted yet; don't cache
        }
        const vendor = (station.chargePointVendor ?? '').toUpperCase();
        isRcd = vendor === 'RCD' || vendor === 'RENOVA';
        this._ocpp16LocalTimeVendorCache.set(key, isRcd);
      } catch {
        return new Date().toISOString();
      }
    }
    return isRcd ? ConfigurationModule._localWallTimeAsIso(tz) : new Date().toISOString();
  }

  @AsHandler([OCPPVersion.OCPP1_6], OCPP_CallAction.Heartbeat)
  protected async _handle16Heartbeat(
    message: IMessage<OCPP1_6.HeartbeatRequest>,
    props?: HandlerProperties,
  ): Promise<void> {
    this._logger.debug('Heartbeat received:', message, props);

    const response: OCPP1_6.HeartbeatResponse = {
      currentTime: await this._ocpp16CurrentTime(
        message.context.tenantId,
        message.context.ocppConnectionName,
      ),
    };

    const messageConfirmation = await this.sendCallResultWithMessage(message, response);
    this._logger.debug('Heartbeat response sent: ', messageConfirmation);
  }

  @AsHandler([OCPPVersion.OCPP1_6], OCPP_CallAction.BootNotification)
  protected async _handleOcpp16BootNotification(
    message: IMessage<OCPP1_6.BootNotificationRequest>,
    props?: HandlerProperties,
  ): Promise<void> {
    this._logger.debug('OCPP 1.6 BootNotification request received:', message, props);

    const ocppConnectionName = message.context.ocppConnectionName;
    const tenantId = message.context.tenantId;
    const request = message.payload;

    // 1. Send BootNotification response
    // Create BootNotification response
    const bootNotificationResponse: OCPP1_6.BootNotificationResponse =
      await this._bootService.createOcpp16BootNotificationResponse(tenantId, ocppConnectionName);

    // RCD local wall-time shim (see _ocpp16CurrentTime): the boot request
    // itself names the vendor, so seed the cache and override here without
    // a DB read.
    {
      const localTz = ConfigurationModule._ocpp16LocalTimeZone();
      const bootVendor = (request.chargePointVendor ?? '').toUpperCase();
      const isRcd = bootVendor === 'RCD' || bootVendor === 'RENOVA';
      this._ocpp16LocalTimeVendorCache.set(`${tenantId}:${ocppConnectionName}`, isRcd);
      if (localTz && isRcd) {
        bootNotificationResponse.currentTime = ConfigurationModule._localWallTimeAsIso(localTz);
      }
    }
    // Check cached boot status for charger. Only Pending and Rejected statuses are cached.
    const cachedBootStatus: OCPP1_6.BootNotificationResponseStatus | null = await this._cache.get(
      BOOT_STATUS,
      ocppConnectionName,
    );
    // Blacklist or whitelist charger actions
    await this._bootService.cacheOcpp16ChargerActionsPermissions(
      ocppConnectionName,
      cachedBootStatus,
      bootNotificationResponse.status,
    );
    // Send BootNotification response
    const bootNotificationResponseMessageConfirmation: IMessageConfirmation =
      await this.sendCallResultWithMessage(message, bootNotificationResponse);
    // Create or update charging station
    this._logger.debug(`Creating or updating charging station: ${ocppConnectionName}`);
    (async () => {
      const connectionJson = await this._cache.get<string>(
        createIdentifier(tenantId, ocppConnectionName),
        CacheNamespace.Connections,
      );
      const connection: IWebsocketConnection | null = connectionJson
        ? JSON.parse(connectionJson)
        : null;
      if (!connection?.allowUnknownChargingStations) {
        const exists = await this._locationRepository.doesChargingStationExistByStationId(
          tenantId,
          ocppConnectionName,
        );
        if (!exists) {
          throw new Error(
            `Charging station ${ocppConnectionName} does not exist and allowUnknownChargingStations is false`,
          );
        }
      }
      await this._locationRepository.createOrUpdateChargingStation(
        tenantId,
        ChargingStation.build({
          tenantId,
          ocppConnectionName,
          chargePointVendor: request.chargePointVendor,
          chargePointModel: request.chargePointModel,
          chargePointSerialNumber: request.chargePointSerialNumber,
          chargeBoxSerialNumber: request.chargeBoxSerialNumber,
          firmwareVersion: request.firmwareVersion,
          iccid: request.iccid,
          imsi: request.imsi,
          meterType: request.meterType,
          meterSerialNumber: request.meterSerialNumber,
        }),
      );
      // Same as the 2.x handler: re-stamp isOnline/protocol for a first-boot
      // station whose row didn't exist at websocket-upgrade time.
      await this._locationRepository.setChargingStationIsOnlineAndOCPPVersion(
        tenantId,
        ocppConnectionName,
        true,
        (message.protocol as OCPPVersion) ?? null,
      );
    })().catch((error) => {
      this._logger.error(`Error updating station ${ocppConnectionName} with boot info:`, error);
    });
    // Check if response was successful
    if (!bootNotificationResponseMessageConfirmation.success) {
      throw new Error(
        'Send BootNotification response failed: ' + bootNotificationResponseMessageConfirmation,
      );
    }

    // 2. Update boot status in cache and db entity
    // Cache boot status for charger if (not accepted) and ((not already cached) or (different status from cached status)).
    if (
      bootNotificationResponse.status !== OCPP1_6.BootNotificationResponseStatus.Accepted &&
      (!cachedBootStatus || bootNotificationResponse.status !== cachedBootStatus)
    ) {
      await this._cache.set(BOOT_STATUS, bootNotificationResponse.status, ocppConnectionName);
    }
    // Update boot with details of most recently sent BootNotificationResponse
    const bootEntity = await this._bootService.updateOcpp16BootConfig(
      bootNotificationResponse,
      tenantId,
      ocppConnectionName,
    );

    // Ivora: every accepted boot re-applies the station's meter sampling interval
    // (see _pushMeterValueSampleInterval). Fire-and-forget; the charger's
    // ChangeConfiguration response lands in _handleOcpp16ChangeConfiguration.
    if (bootNotificationResponse.status === OCPP1_6.BootNotificationResponseStatus.Accepted) {
      this._pushMeterValueSampleInterval(tenantId, ocppConnectionName, OCPPVersion.OCPP1_6).catch(
        (error) =>
          this._logger.warn(
            `Failed to push MeterValueSampleInterval to ${ocppConnectionName} after boot:`,
            error,
          ),
      );
    }

    // 3. Sync configurations
    // If boot notification is not pending, do not start configuration.
    // If cached boot status is not null and pending, configuration is already in progress - do not start configuration again.
    if (
      bootNotificationResponse.status !== OCPP1_6.BootNotificationResponseStatus.Pending ||
      (cachedBootStatus && cachedBootStatus === OCPP1_6.BootNotificationResponseStatus.Pending)
    ) {
      return;
    }
    let changeConfigurationsOnPending: boolean = false;
    let getConfigurationsOnPending: boolean = true;
    // Change Configurations on charging station
    const configurations: ChangeConfiguration[] =
      await this._changeConfigurationRepository.readAllByQuery(tenantId, {
        where: {
          ocppConnectionName,
        },
      });
    // Remove ChangeConfiguration call action from blacklist
    await this._cache.remove(OCPP_CallAction.ChangeConfiguration, ocppConnectionName);
    // Set each configuration on Charging Station
    for (const config of configurations) {
      const correlationId = uuidv4();

      const cacheCallbackPromise: Promise<string | null> = this._cache.onChange(
        correlationId,
        this._config.maxCachingSeconds,
        ocppConnectionName,
      );
      const changeConfigurationResponseMessageConfirmation: IMessageConfirmation =
        await this.sendCall(
          ocppConnectionName,
          tenantId,
          OCPPVersion.OCPP1_6,
          OCPP_CallAction.ChangeConfiguration,
          {
            key: config.key,
            value: config.value,
          } as OCPP1_6.ChangeConfigurationRequest,
          undefined,
          correlationId,
        );
      if (!changeConfigurationResponseMessageConfirmation.success) {
        changeConfigurationsOnPending = true;
      }
      // wait before sending next call
      await cacheCallbackPromise;
    }

    // Get Configurations from charging station
    // Remove GetConfiguration call action from blacklist
    await this._cache.remove(OCPP_CallAction.GetConfiguration, ocppConnectionName);
    // Send GetConfiguration request to charger
    const getConfigurationResponseMessageConfirmation: IMessageConfirmation = await this.sendCall(
      ocppConnectionName,
      tenantId,
      OCPPVersion.OCPP1_6,
      OCPP_CallAction.GetConfiguration,
      {} as OCPP1_6.GetConfigurationRequest, // empty to get all configs
    );
    if (getConfigurationResponseMessageConfirmation.success) {
      getConfigurationsOnPending = false;
    }
    // Update configuration related fields on boot entity
    await this._bootRepository.updateByKey(
      tenantId,
      {
        changeConfigurationsOnPending,
        getConfigurationsOnPending,
      },
      bootEntity.id,
    );

    // 4. Trigger another boot when pending
    await this._cache.remove(OCPP_CallAction.TriggerMessage, ocppConnectionName);
    await this.sendCall(
      ocppConnectionName,
      tenantId,
      OCPPVersion.OCPP1_6,
      OCPP_CallAction.TriggerMessage,
      {
        requestedMessage: OCPP1_6.TriggerMessageRequestRequestedMessage.BootNotification,
      } as OCPP1_6.TriggerMessageRequest,
    );
  }

  /**
   * Ivora: push the station's meter sampling configuration to the charger.
   *
   * Interval: ChargingStations.meterValueSampleInterval (seconds, editable per
   * station in the operator UI). NULL means "leave the charger's own value
   * alone". A station row that does not exist yet (first boot of an unknown
   * charger) gets PlatformSettings.defaultMeterValueSampleInterval (20 when
   * unset).
   *
   * Measurands: PlatformSettings.meterValuesSampledData (comma-separated),
   * platform-wide, pushed only when non-empty.
   *
   * Applied on every accepted boot so a factory-reset or vendor-default charger
   * (Wallbox ships 300 s, energy register only) starts reporting live
   * MeterValues without anyone sending a ChangeConfiguration by hand.
   *
   * OCPP 1.6: ChangeConfiguration MeterValueSampleInterval / MeterValuesSampledData.
   * OCPP 2.0.1 / 2.1: SetVariables SampledDataCtrlr.TxUpdatedInterval / TxUpdatedMeasurands.
   */
  protected async _pushMeterValueSampleInterval(
    tenantId: number,
    ocppConnectionName: string,
    protocol: OCPPVersion,
  ): Promise<void> {
    const settings = await this._readPlatformSettings();

    const station = await this._locationRepository.readChargingStationByStationId(
      tenantId,
      ocppConnectionName,
    );
    const interval = station ? station.meterValueSampleInterval : settings.defaultInterval;

    const measurands = settings.measurands;

    if (interval === null || interval === undefined) {
      this._logger.debug(
        `Station ${ocppConnectionName} has no meterValueSampleInterval; leaving charger value as-is`,
      );
    }
    const intervalValue =
      interval === null || interval === undefined
        ? null
        : String(Math.max(0, Math.trunc(Number(interval))));

    if (intervalValue === null && !measurands) {
      return;
    }

    if (protocol === OCPPVersion.OCPP1_6) {
      const keys: Array<[string, string]> = [];
      if (intervalValue !== null) keys.push(['MeterValueSampleInterval', intervalValue]);
      if (measurands) keys.push(['MeterValuesSampledData', measurands]);
      for (const [key, value] of keys) {
        this._logger.info(`Pushing ${key}=${value} to ${ocppConnectionName} after boot`);
        // Sequential: chargers must answer one CSMS call before the next.
        await this._sendCallAndAwaitResponse(ocppConnectionName, tenantId, protocol, key, value);
      }
      return;
    }

    const setVariableData: OCPP2_common_types.SetVariableDataType[] = [];
    if (intervalValue !== null) {
      setVariableData.push({
        component: { name: 'SampledDataCtrlr' },
        variable: { name: 'TxUpdatedInterval' },
        attributeValue: intervalValue,
      });
    }
    if (measurands) {
      setVariableData.push({
        component: { name: 'SampledDataCtrlr' },
        variable: { name: 'TxUpdatedMeasurands' },
        attributeValue: measurands,
      });
    }
    this._logger.info(
      `Pushing SampledDataCtrlr ${setVariableData.map((v) => `${v.variable.name}=${v.attributeValue}`).join(', ')} to ${ocppConnectionName} after boot`,
    );
    await this.sendCall(ocppConnectionName, tenantId, protocol, OCPP_CallAction.SetVariables, {
      setVariableData,
    } as OCPP2_request_types.SetVariablesRequest);
  }

  /** One OCPP 1.6 ChangeConfiguration, resolved when the charger answers (or the cache times out). */
  private async _sendCallAndAwaitResponse(
    ocppConnectionName: string,
    tenantId: number,
    protocol: OCPPVersion,
    key: string,
    value: string,
  ): Promise<void> {
    const correlationId = uuidv4();
    const responsePromise = this._cache.onChange(
      correlationId,
      this._config.maxCachingSeconds,
      ocppConnectionName,
    );
    const confirmation = await this.sendCall(
      ocppConnectionName,
      tenantId,
      protocol,
      OCPP_CallAction.ChangeConfiguration,
      { key, value } as OCPP1_6.ChangeConfigurationRequest,
      undefined,
      correlationId,
    );
    if (!confirmation.success) {
      this._logger.warn(`ChangeConfiguration ${key} to ${ocppConnectionName} was not sent`);
      return;
    }
    await responsePromise;
  }

  /** PlatformSettings the boot push consumes; tolerant of a missing repository or table. */
  private async _readPlatformSettings(): Promise<{
    defaultInterval: number;
    measurands: string | null;
  }> {
    let defaultInterval: number = ConfigurationModule.DEFAULT_METER_VALUE_SAMPLE_INTERVAL;
    let measurands: string | null = null;
    if (!this._platformSettingRepository) {
      return { defaultInterval, measurands };
    }
    try {
      const all = await this._platformSettingRepository.getAll();
      const rawInterval = all[PlatformSettingKey.defaultMeterValueSampleInterval];
      if (rawInterval !== undefined && rawInterval !== null && rawInterval.trim() !== '') {
        const parsed = Number(rawInterval);
        if (Number.isFinite(parsed) && parsed >= 0) defaultInterval = parsed;
      }
      const rawMeasurands = all[PlatformSettingKey.meterValuesSampledData];
      if (rawMeasurands && rawMeasurands.trim() !== '') {
        measurands = rawMeasurands
          .split(',')
          .map((m) => m.trim())
          .filter((m) => m.length > 0)
          .join(',');
      }
    } catch (error) {
      this._logger.warn('Could not read PlatformSettings; using built-in defaults', error);
    }
    return { defaultInterval, measurands };
  }

  /**
   * Handle OCPP 1.6 response
   */
  @AsHandler([OCPPVersion.OCPP1_6], OCPP_CallAction.GetConfiguration)
  protected async _handleOcpp16GetConfiguration(
    message: IMessage<OCPP1_6.GetConfigurationResponse>,
    props?: HandlerProperties,
  ): Promise<void> {
    this._logger.debug('OCPP 1.6 GetConfiguration response received:', message, props);

    const tenantId = message.context.tenantId;
    const ocppConnectionName = message.context.ocppConnectionName;
    const configurations = message.payload.configurationKey;

    if (configurations && configurations.length > 0) {
      for (const config of configurations) {
        if (config.key) {
          await this._changeConfigurationRepository.createOrUpdateChangeConfiguration(tenantId, {
            ocppConnectionName,
            key: config.key,
            value: config.value,
            readonly: config.readonly,
          } as ChangeConfiguration);
        }
      }
    }
  }

  @AsHandler([OCPPVersion.OCPP1_6], OCPP_CallAction.ChangeConfiguration)
  protected async _handleOcpp16ChangeConfiguration(
    message: IMessage<OCPP1_6.ChangeConfigurationResponse>,
    props?: HandlerProperties,
  ): Promise<void> {
    this._logger.debug('OCPP 1.6 ChangeConfiguration response received:', message, props);

    const tenantId = message.context.tenantId;
    const ocppConnectionName = message.context.ocppConnectionName;
    const correlationId = message.context.correlationId;

    const request = await this._ocppMessageRepository.readOnlyOneByQuery(tenantId, {
      where: {
        ocppConnectionName: ocppConnectionName,
        correlationId,
        origin: MessageOrigin.ChargingStationManagementSystem,
      },
    });

    if (!request) {
      this._logger.error(
        `No valid ChangeConfigurationRequest found for correlationId ${correlationId}`,
      );
    }

    const status = message.payload.status;
    const key = request?.message[3].key;
    const value = request?.message[3].value;

    if (
      status == OCPP1_6.ChangeConfigurationResponseStatus.Rejected ||
      status == OCPP1_6.ChangeConfigurationResponseStatus.NotSupported
    ) {
      this._logger.warn(
        `Attempted ChangeConfiguration ${correlationId} for ${key}:${value} unsuccessful with status ${status}`,
      );
      return;
    } else {
      const config = await this._changeConfigurationRepository.createOrUpdateChangeConfiguration(
        tenantId,
        {
          tenantId,
          ocppConnectionName,
          key,
          value,
        } as ChangeConfiguration,
      );
      if (!config) {
        this._logger.error(
          `Failed to create or update configuration ${key}:${value} on ${ocppConnectionName}`,
        );
      } else {
        this._logger.debug(`Updated changeConfiguration ${key}:${value}`);
      }
    }
  }

  @AsHandler([OCPPVersion.OCPP1_6], OCPP_CallAction.TriggerMessage)
  protected _handleOcpp16TriggerMessage(
    message: IMessage<OCPP1_6.TriggerMessageResponse>,
    props?: HandlerProperties,
  ): void {
    this._logger.debug('TriggerMessage response received:', message, props);
    if (message.payload.status !== OCPP1_6.TriggerMessageResponseStatus.Accepted) {
      this._logger.error('TriggerMessage failed with status:', message);
    }
  }

  @AsHandler([OCPPVersion.OCPP1_6], OCPP_CallAction.Reset)
  protected _handle16Reset(
    message: IMessage<OCPP1_6.ResetResponse>,
    props?: HandlerProperties,
  ): void {
    this._logger.debug('Reset response received:', message, props);
  }

  @AsHandler([OCPPVersion.OCPP1_6], OCPP_CallAction.ChangeAvailability)
  protected _handleOcpp16ChangeAvailability(
    message: IMessage<OCPP1_6.ChangeAvailabilityResponse>,
    props?: HandlerProperties,
  ): void {
    this._logger.debug('ChangeAvailability response received:', message, props);
  }

  // Data Transfer can be either a request or a response

  @AsHandler([OCPPVersion.OCPP1_6], OCPP_CallAction.DataTransfer)
  protected async _handleOcpp16DataTransfer(
    message: IMessage<OCPP1_6.DataTransferRequest | OCPP1_6.DataTransferResponse>,
    props?: HandlerProperties,
  ): Promise<void> {
    this._logger.debug('DataTransfer received:', message, props);

    if (message.state === MessageState.Request) {
      const request = message.payload as OCPP1_6.DataTransferRequest;
      let response: OCPP1_6.DataTransferResponse = {
        status: OCPP1_6.DataTransferResponseStatus.Rejected,
      };
      // RCD ("Renova") tunnels its vendor protocol (realtime_status, bill,
      // ...) through DataTransfer; the payment service consumes these off the
      // broker. Acknowledge them in the firmware's own <op>_conf convention
      // (observed on the wire: qrcode_req -> {"messageId":"qrcode_conf"})
      // so the charger keeps sending instead of retrying/backing off.
      // Everything else stays Rejected as before.
      if ((request.vendorId ?? '').toLowerCase() === 'rcd') {
        const operation = (request.messageId ?? '').replace(/_(req|send)$/, '');
        response = {
          status: OCPP1_6.DataTransferResponseStatus.Accepted,
          data: JSON.stringify({ messageId: `${operation}_conf`, result: 0 }),
        };
      }

      const messageConfirmation = await this.sendCallResultWithMessage(message, response);
      this._logger.debug('DataTransfer response sent: ', messageConfirmation);
    } else {
      this._logger.debug('DataTransfer response received:', message, props);
    }
  }
}

export default ConfigurationModule;
