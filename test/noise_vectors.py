"""Generate random Noise_NNpsk0_25519_ChaChaPoly_SHA256 transcripts with the Python `noise`
library (noiseprotocol), an implementation independent of ours, in cacophony's vector format.
Usage: python noise_vectors.py COUNT SEED > vectors.json"""
import json, random, sys
from noise.connection import NoiseConnection, Keypair

NAME = b'Noise_NNpsk0_25519_ChaChaPoly_SHA256'

def one(rng):
    psk, prologue = rng.randbytes(32), rng.randbytes(rng.randrange(0, 40))
    ie, re = rng.randbytes(32), rng.randbytes(32)
    i, r = NoiseConnection.from_name(NAME), NoiseConnection.from_name(NAME)
    for conn, eph, role in ((i, ie, 'set_as_initiator'), (r, re, 'set_as_responder')):
        getattr(conn, role)()
        conn.set_psks(psk)
        conn.set_prologue(prologue)
        conn.set_keypair_from_private_bytes(Keypair.EPHEMERAL, eph)
        conn.start_handshake()
    msgs = []
    p = rng.randbytes(rng.randrange(0, 64)); c = i.write_message(p); assert r.read_message(c) == p; msgs.append((p, c))
    p = rng.randbytes(rng.randrange(0, 64)); c = r.write_message(p); assert i.read_message(c) == p; msgs.append((p, c))
    for n in range(rng.randrange(1, 6)):
        a, b = (i, r) if n % 2 == 0 else (r, i)
        p = rng.randbytes(rng.randrange(0, 300)); c = a.encrypt(p); assert b.decrypt(c) == p; msgs.append((p, c))
    assert i.get_handshake_hash() == r.get_handshake_hash()
    return {
        'protocol_name': NAME.decode(), 'init_prologue': prologue.hex(), 'resp_prologue': prologue.hex(),
        'init_psks': [psk.hex()], 'resp_psks': [psk.hex()], 'init_ephemeral': ie.hex(), 'resp_ephemeral': re.hex(),
        'handshake_hash': i.get_handshake_hash().hex(),
        'messages': [{'payload': p.hex(), 'ciphertext': c.hex()} for p, c in msgs],
    }

if __name__ == '__main__':
    rng = random.Random(int(sys.argv[2]))
    print(json.dumps({'vectors': [one(rng) for _ in range(int(sys.argv[1]))]}))
