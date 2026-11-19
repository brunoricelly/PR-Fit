"""Invite race, deletion of a linked athlete with prescriptions: leftovers in the stored db, cleanup jobs, restart.
Usage: 4_race_account_delete.py before | after"""
import concurrent.futures as cf
import sys
from _common import *

phase = sys.argv[1] if len(sys.argv) > 1 else 'before'
if phase == 'before':
    c, _ = reg('coachc'); c.post(B + '/api/profile', json={'kind': 'coach', 'coachSpecialties': ['training']})
    x1, _ = reg('alunox1'); x2, _ = reg('alunox2')
    tok = j(c.post(B + '/api/coach/invites', json={'scopes': ['training']}))['invite']['token']
    with cf.ThreadPoolExecutor(2) as ex:
        rs = sorted(ex.map(lambda s: s.post(B + '/api/coach/invites/accept', json={'token': tok}).status_code, [x1, x2]))
    chk('corrida mesmo convite: um 200 e um 409', rs == [200, 409], rs)
    links = [l for l in j(c.get(B + '/api/coach/athletes'))['links'] if l['status'] == 'active']
    chk('um unico vinculo ativo', len(links) == 1, len(links))
    act = links[0]['athlete']['id']
    who, nm = (x1, 'alunox1') if uid(x1) == act else (x2, 'alunox2')
    r = c.post(B + f'/api/coach/athletes/{act}/routines', json={'routine': {'name': 'R', 'notes': '', 'divisions': [{'name': 'A', 'exercises': [{'name': 'S', 'sets': 3, 'reps': '10', 'load': '', 'restSeconds': 60, 'notes': ''}]}]}})
    chk('coach prescreve ao aluno', r.status_code in (200, 201), r.status_code)
    pre = [k for k, v in read_db().items() if isinstance(v, list) and any(isinstance(x, dict) and (x.get('athleteId') == act or x.get('userId') == act) for x in v)]
    info('colecoes com registros do aluno antes de excluir:', pre)
    r = who.post(B + '/api/account/delete', json={'name': nm, 'password': PW, 'current': PW}); chk('exclusao de conta', r.status_code == 200, r.status_code)
    chk('coach nao enxerga o aluno excluido', not any((l.get('athlete') or {}).get('id') == act for l in j(c.get(B + '/api/coach/athletes'))['links']))
    d = read_db()
    left = {k: sum(1 for x in v if isinstance(x, dict) and (x.get('athleteId') == act or x.get('userId') == act)) for k, v in d.items() if isinstance(v, list)}
    left = {k: n for k, n in left.items() if n and k != 'accountCleanupJobs'}
    chk('sem residuos do aluno excluido no db armazenado', not left, left)
    jobs = [(x['status'], x['attempts']) for x in d.get('accountCleanupJobs', [])]
    info('jobs cleanup:', jobs)
    chk('nenhum job de limpeza pendente/falho', all(s in ('complete', 'done') for s, _ in jobs) or not jobs, jobs)
    save('s4', {'act': act, 'links': sorted((l['id'], l['status']) for l in j(c.get(B + '/api/coach/athletes'))['links'])})
    summary('4_race_account_delete(before)')
else:
    st = load('s4'); c = login('coachc')
    links = j(c.get(B + '/api/coach/athletes'))['links']
    chk('persistencia apos restart: vinculos iguais', sorted([l['id'], l['status']] for l in links) == st['links'], len(links))
    chk('aluno excluido continua fora', not any((l.get('athlete') or {}).get('id') == st['act'] for l in links))
    d = read_db()
    chk('db sem usuario excluido', not any(u.get('id') == st['act'] for u in d['users']))
    summary('4_race_account_delete(after)')
