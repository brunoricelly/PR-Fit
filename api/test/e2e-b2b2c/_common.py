"""Helpers shared by the e2e scripts: HTTP sessions, PASS/FAIL asserts, SUMMARY line, small state file."""
import json, os, subprocess, sys
import requests

B = os.environ.get('B2B_BASE', 'http://localhost:3999')
PW = 'Tst-Pass-93847!xq'
TMP = os.environ.get('E2E_TMP') or os.path.join(os.environ.get('TMPDIR', '/tmp'), 'b2b2c-e2e')
os.makedirs(TMP, exist_ok=True)
HERE = os.path.dirname(os.path.abspath(__file__))
_results = []


def reg(name):
    s = requests.Session()
    r = s.post(B + '/api/register/password', json={'name': name, 'password': PW, 'email': None})
    return s, r


def login(name):
    s = requests.Session()
    s.post(B + '/api/login/password', json={'name': name, 'password': PW})
    return s


def j(r):
    try:
        return r.json()
    except Exception:
        return r.text[:100]


def uid(s):
    d = j(s.get(B + '/api/me'))
    return (d.get('user') or d).get('id')


def chk(name, ok, detail=''):
    ok = bool(ok)
    _results.append(ok)
    print(('PASS' if ok else 'FAIL'), name, detail)


def info(*a):
    print('INFO', *a)


def save(name, data):
    json.dump(data, open(os.path.join(TMP, name + '.json'), 'w'))


def load(name):
    return json.load(open(os.path.join(TMP, name + '.json')))


def read_db():
    """The db document as the store holds it (db.json or the PostgreSQL rows), read by the node helper."""
    out = subprocess.run(['node', os.path.join(HERE, 'read-db.mjs')], capture_output=True, text=True, cwd=os.path.join(HERE, '..', '..'))
    if out.returncode:
        raise RuntimeError(out.stderr[-500:])
    return json.loads(out.stdout)


def summary(label):
    p, f = _results.count(True), _results.count(False)
    print(f'SUMMARY {label} {p} PASS, {f} FAIL')
    sys.exit(1 if f else 0)
