"""Acceptance driver: connect with aioesphomeapi (what Home Assistant uses) and exercise the
device. Prints one JSON line per step so the Node test can assert on it."""
import asyncio, json, sys, math
import aioesphomeapi
from aioesphomeapi import APIClient

async def main(port, key, password):
    out = lambda **kw: print(json.dumps(kw), flush=True)
    cli = APIClient("127.0.0.1", int(port), password or None, noise_psk=key or None, client_info="acceptance-test")
    await cli.connect(login=True)
    out(step="connected", api=str(cli.api_version))
    info = await cli.device_info()
    out(step="device_info", name=info.name, mac=info.mac_address, friendly=info.friendly_name, version=info.esphome_version,
        project=info.project_name, enc=info.api_encryption_supported, uses_password=info.uses_password)
    entities, services = await cli.list_entities_services()
    out(step="entities", entities=sorted(f"{type(e).__name__}:{e.object_id}:{e.key}" for e in entities),
        services=[{"name": s.name, "args": [(a.name, int(a.type)) for a in s.args]} for s in services])
    by_id = {e.object_id: e for e in entities}
    states = {}
    got = asyncio.Event()
    def on_state(s):
        states[s.key] = s
        got.set()
    cli.subscribe_states(on_state)
    await asyncio.sleep(0.3)
    def snap():
        r = {}
        for oid, e in by_id.items():
            s = states.get(e.key)
            if s is None: r[oid] = None
            elif getattr(s, "missing_state", False): r[oid] = "missing"
            else:
                if type(s).__name__ == "Event": v = s.event_type
                elif type(s).__name__ == "UpdateState": v = [s.current_version, s.latest_version]
                else: v = getattr(s, "state", None)
                r[oid] = (None if isinstance(v, float) and math.isnan(v) else v)
        return r
    out(step="states", states=snap())
    # commands
    cli.switch_command(by_id["lamp"].key, True)
    cli.select_command(by_id["mode"].key, "Party")
    cli.number_command(by_id["level"].key, 65)
    cli.text_command(by_id["message"].key, "hello there")
    cli.button_command(by_id["reboot"].key)
    cli.update_command(by_id["firmware"].key, aioesphomeapi.UpdateCommand.INSTALL)
    await asyncio.sleep(0.4)
    out(step="after_commands", states=snap())
    # Actions the device asks HA to perform
    actions = []
    cli.subscribe_service_calls(lambda c: actions.append({"service": c.service, "data": dict(c.data), "is_event": c.is_event}))
    await asyncio.sleep(0.5)
    out(step="actions", actions=actions)
    # user-defined service
    svc = next(s for s in services if s.name == "say")
    await cli.execute_service(svc, {"text": "hi", "times": 3, "flags": [True, False], "nums": [-2, 7]})
    await asyncio.sleep(0.3)
    out(step="service_sent")
    # HA state subscription from the device side
    seen = []
    cli.subscribe_home_assistant_states(lambda entity_id, attribute: seen.append([entity_id, attribute]))
    await asyncio.sleep(0.3)
    cli.send_home_assistant_state("light.desk", None, "on")
    await asyncio.sleep(0.3)
    out(step="ha_subs", subs=seen)
    # log subscription
    logs = []
    cli.subscribe_logs(lambda m: logs.append(m.message.decode()), log_level=aioesphomeapi.LogLevel.LOG_LEVEL_DEBUG)
    await asyncio.sleep(0.2)
    out(step="logs_subscribed")          # the test answers by sending a log line
    await asyncio.sleep(0.6)
    out(step="logs", logs=logs)
    out(step="waiting_final")            # the test answers by pushing states and an event
    await asyncio.sleep(0.8)
    out(step="final", states=snap())
    await cli.disconnect()
    out(step="done")

asyncio.run(main(*sys.argv[1:4]))
