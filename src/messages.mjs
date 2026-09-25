// The subset of the ESPHome native API this library speaks. Ids and field numbers come from
// esphome/components/api/api.proto; fields the library never uses are left out, which is safe
// because protobuf skips unknown fields on both sides.

const M = (name, id, fields) => ({ name, id, fields });

export const EntityCategory = { NONE: 0, CONFIG: 1, DIAGNOSTIC: 2 };
export const StateClass = { NONE: 0, MEASUREMENT: 1, TOTAL_INCREASING: 2, TOTAL: 3 };
export const NumberMode = { AUTO: 0, BOX: 1, SLIDER: 2 };
export const TextMode = { TEXT: 0, PASSWORD: 1 };
export const LogLevel = { NONE: 0, ERROR: 1, WARN: 2, INFO: 3, CONFIG: 4, DEBUG: 5, VERBOSE: 6, VERY_VERBOSE: 7 };
export const ServiceArgType = { BOOL: 0, INT: 1, FLOAT: 2, STRING: 3, BOOL_ARRAY: 4, INT_ARRAY: 5, FLOAT_ARRAY: 6, STRING_ARRAY: 7 };
export const SupportsResponse = { NONE: 0, OPTIONAL: 1, ONLY: 2, STATUS: 100 };
export const DisconnectReason = { UNSPECIFIED: 0, USER_INITIATED: 1, RESTARTING: 2, OTA_UPDATE: 3, DEEP_SLEEP: 4 };

const entityInfo = (extra) => ({ object_id: [1, 'string'], key: [2, 'fixed32'], name: [3, 'string'], ...extra });

const AreaInfo = M('AreaInfo', 0, { area_id: [1, 'uint32'], name: [2, 'string'] });
const DeviceInfo = M('DeviceInfo', 0, { device_id: [1, 'uint32'], name: [2, 'string'], area_id: [3, 'uint32'] });
const ServiceArgument = M('ListEntitiesServicesArgument', 0, { name: [1, 'string'], type: [2, 'enum'], description: [3, 'string'], example: [4, 'string'] });
const ExecuteServiceArgument = M('ExecuteServiceArgument', 0, {
  bool_: [1, 'bool'], legacy_int: [2, 'int32'], float_: [3, 'float'], string_: [4, 'string'], int_: [5, 'sint32'],
  bool_array: [6, 'bool[]'], int_array: [7, 'sint32[]'], float_array: [8, 'float[]'], string_array: [9, 'string[]'],
});
const ServiceMap = M('HomeassistantServiceMap', 0, { key: [1, 'string'], value: [2, 'string'] });

export const messages = [
  M('HelloRequest', 1, { client_info: [1, 'string'], api_version_major: [2, 'uint32'], api_version_minor: [3, 'uint32'] }),
  M('HelloResponse', 2, { api_version_major: [1, 'uint32'], api_version_minor: [2, 'uint32'], server_info: [3, 'string'], name: [4, 'string'] }),
  M('AuthenticationRequest', 3, { password: [1, 'string'] }),
  M('AuthenticationResponse', 4, { invalid_password: [1, 'bool'] }),
  M('DisconnectRequest', 5, { reason: [1, 'enum'] }),
  M('DisconnectResponse', 6, {}),
  M('PingRequest', 7, {}),
  M('PingResponse', 8, {}),
  M('DeviceInfoRequest', 9, {}),
  M('DeviceInfoResponse', 10, {
    uses_password: [1, 'bool'], name: [2, 'string'], mac_address: [3, 'string'], esphome_version: [4, 'string'],
    compilation_time: [5, 'string'], model: [6, 'string'], has_deep_sleep: [7, 'bool'], project_name: [8, 'string'],
    project_version: [9, 'string'], webserver_port: [10, 'uint32'], manufacturer: [12, 'string'], friendly_name: [13, 'string'],
    suggested_area: [16, 'string'], api_encryption_supported: [19, 'bool'], devices: [20, [DeviceInfo]], areas: [21, [AreaInfo]],
    area: [22, AreaInfo], api_encryption_provisionable: [26, 'bool'],
  }),
  M('ListEntitiesRequest', 11, {}),
  M('ListEntitiesDoneResponse', 19, {}),
  M('SubscribeStatesRequest', 20, {}),
  M('SubscribeLogsRequest', 28, { level: [1, 'enum'], dump_config: [2, 'bool'] }),
  M('SubscribeLogsResponse', 29, { level: [1, 'enum'], message: [3, 'bytes'] }),
  M('SubscribeHomeassistantServicesRequest', 34, {}),
  M('HomeassistantActionRequest', 35, { service: [1, 'string'], data: [2, [ServiceMap]], data_template: [3, [ServiceMap]], variables: [4, [ServiceMap]], is_event: [5, 'bool'] }),
  M('GetTimeRequest', 36, {}),
  M('GetTimeResponse', 37, { epoch_seconds: [1, 'fixed32'], timezone: [2, 'string'] }),
  M('SubscribeHomeAssistantStatesRequest', 38, {}),
  M('SubscribeHomeAssistantStateResponse', 39, { entity_id: [1, 'string'], attribute: [2, 'string'], once: [3, 'bool'] }),
  M('HomeAssistantStateResponse', 40, { entity_id: [1, 'string'], state: [2, 'string'], attribute: [3, 'string'] }),
  M('ListEntitiesServicesResponse', 41, { name: [1, 'string'], key: [2, 'fixed32'], args: [3, [ServiceArgument]], supports_response: [4, 'enum'], description: [5, 'string'] }),
  M('ExecuteServiceRequest', 42, { key: [1, 'fixed32'], args: [2, [ExecuteServiceArgument]], call_id: [3, 'uint32'], return_response: [4, 'bool'] }),
  M('ExecuteServiceResponse', 131, { call_id: [1, 'uint32'], success: [2, 'bool'], error_message: [3, 'string'], response_data: [4, 'bytes'] }),
  M('NoiseEncryptionSetKeyRequest', 124, { key: [1, 'bytes'] }),
  M('NoiseEncryptionSetKeyResponse', 125, { success: [1, 'bool'] }),

  // Entities: list (info) responses, state responses, command requests.
  M('ListEntitiesBinarySensorResponse', 12, entityInfo({ device_class: [5, 'string'], is_status_binary_sensor: [6, 'bool'], disabled_by_default: [7, 'bool'], icon: [8, 'string'], entity_category: [9, 'enum'] })),
  M('BinarySensorStateResponse', 21, { key: [1, 'fixed32'], state: [2, 'bool'], missing_state: [3, 'bool'] }),
  M('ListEntitiesSensorResponse', 16, entityInfo({ icon: [5, 'string'], unit_of_measurement: [6, 'string'], accuracy_decimals: [7, 'int32'], force_update: [8, 'bool'], device_class: [9, 'string'], state_class: [10, 'enum'], disabled_by_default: [12, 'bool'], entity_category: [13, 'enum'] })),
  M('SensorStateResponse', 25, { key: [1, 'fixed32'], state: [2, 'float'], missing_state: [3, 'bool'] }),
  M('ListEntitiesSwitchResponse', 17, entityInfo({ icon: [5, 'string'], assumed_state: [6, 'bool'], disabled_by_default: [7, 'bool'], entity_category: [8, 'enum'], device_class: [9, 'string'] })),
  M('SwitchStateResponse', 26, { key: [1, 'fixed32'], state: [2, 'bool'] }),
  M('SwitchCommandRequest', 33, { key: [1, 'fixed32'], state: [2, 'bool'] }),
  M('ListEntitiesTextSensorResponse', 18, entityInfo({ icon: [5, 'string'], disabled_by_default: [6, 'bool'], entity_category: [7, 'enum'], device_class: [8, 'string'] })),
  M('TextSensorStateResponse', 27, { key: [1, 'fixed32'], state: [2, 'string'], missing_state: [3, 'bool'] }),
  M('ListEntitiesNumberResponse', 49, entityInfo({ icon: [5, 'string'], min_value: [6, 'float'], max_value: [7, 'float'], step: [8, 'float'], disabled_by_default: [9, 'bool'], entity_category: [10, 'enum'], unit_of_measurement: [11, 'string'], mode: [12, 'enum'], device_class: [13, 'string'] })),
  M('NumberStateResponse', 50, { key: [1, 'fixed32'], state: [2, 'float'], missing_state: [3, 'bool'] }),
  M('NumberCommandRequest', 51, { key: [1, 'fixed32'], state: [2, 'float'] }),
  M('ListEntitiesSelectResponse', 52, entityInfo({ icon: [5, 'string'], options: [6, 'string[]'], disabled_by_default: [7, 'bool'], entity_category: [8, 'enum'] })),
  M('SelectStateResponse', 53, { key: [1, 'fixed32'], state: [2, 'string'], missing_state: [3, 'bool'] }),
  M('SelectCommandRequest', 54, { key: [1, 'fixed32'], state: [2, 'string'] }),
  M('ListEntitiesButtonResponse', 61, entityInfo({ icon: [5, 'string'], disabled_by_default: [6, 'bool'], entity_category: [7, 'enum'], device_class: [8, 'string'] })),
  M('ButtonCommandRequest', 62, { key: [1, 'fixed32'] }),
  M('ListEntitiesTextResponse', 97, entityInfo({ icon: [5, 'string'], disabled_by_default: [6, 'bool'], entity_category: [7, 'enum'], min_length: [8, 'uint32'], max_length: [9, 'uint32'], pattern: [10, 'string'], mode: [11, 'enum'] })),
  M('TextStateResponse', 98, { key: [1, 'fixed32'], state: [2, 'string'], missing_state: [3, 'bool'] }),
  M('TextCommandRequest', 99, { key: [1, 'fixed32'], state: [2, 'string'] }),
  M('ListEntitiesEventResponse', 107, entityInfo({ icon: [5, 'string'], disabled_by_default: [6, 'bool'], entity_category: [7, 'enum'], device_class: [8, 'string'], event_types: [9, 'string[]'] })),
  M('EventResponse', 108, { key: [1, 'fixed32'], event_type: [2, 'string'] }),
];

export const byName = Object.fromEntries(messages.map((m) => [m.name, m]));
export const byId = new Map(messages.map((m) => [m.id, m]));
