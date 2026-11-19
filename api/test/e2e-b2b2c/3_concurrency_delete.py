"""Concurrent invite acceptance, account deletion of a linked athlete, persistence across restart.
Usage: 3_concurrency_delete.py before | after   (the runner restarts the API in between)."""
import concurrent.futures as cf
import sys
from _common import *

phase = sys.argv[1] if len(sys.argv) > 1 else 'before'
if phase == 'before':
    cD, _ = reg('coachd'); cD.post(B + '/api/profile', json={'kind': 'coach', 'coachSpecialties': ['training', 'nutrition']})
    s2, _ = reg('aluno2b'); s3, _ = reg('aluno3b')
    for n, s in (('aluno2b', s2), ('aluno3b', s3)):
        t = j(cD.post(B + '/api/coach/invites', json={'scopes': ['training', 'nutrition']}))
        chk(f'convite para {n}', 'invite' in t)
        chk(f'{n} aceita', s.post(B + '/api/coach/invites/accept', json={'token': t['invite']['token']}).status_code == 200)
    # same invite, two athletes at once
    c1, _ = reg('corr1'); c2, _ = reg('corr2')
    tok = j(cD.post(B + '/api/coach/invites', json={'scopes': ['training']}))['invite']['token']
    with cf.ThreadPoolExecutor(2) as ex:
        rs = sorted(ex.map(lambda s: s.post(B + '/api/coach/invites/accept', json={'token': tok}).status_code, [c1, c2]))
    chk('corrida no mesmo convite: um 200 e um 409', rs == [200, 409], rs)
    # six different invites accepted in parallel
    many = [reg(f'par{i}')[0] for i in range(6)]
    toks = [j(cD.post(B + '/api/coach/invites', json={'scopes': ['training']}))['invite']['token'] for _ in many]
    with cf.ThreadPoolExecutor(6) as ex:
        rs = list(ex.map(lambda p: p[0].post(B + '/api/coach/invites/accept', json={'token': p[1]}).status_code, zip(many, toks)))
    chk('6 aceites paralelos de convites distintos: todos 200', rs == [200] * 6, rs)
    active = [l for l in j(cD.get(B + '/api/coach/athletes'))['links'] if l['status'] == 'active']
    chk('coach tem 2+1+6 = 9 vinculos ativos', len(active) == 9, len(active))
    # delete an athlete's account
    a2id = uid(s2)
    r = s2.post(B + '/api/account/delete', json={'name': 'aluno2b', 'password': PW, 'current': PW}); chk('exclusao de conta do aluno', r.status_code == 200, r.status_code)
    links = j(cD.get(B + '/api/coach/athletes'))['links']
    chk('coach nao ve aluno excluido', not any((l.get('athlete') or {}).get('id') == a2id for l in links))
    chk('coach perde acesso as rotinas do excluido', cD.get(B + f'/api/coach/athletes/{a2id}/routines').status_code in (403, 404))
    save('s3', sorted((l['id'], l['status']) for l in links))
    summary('3_concurrency_delete(before)')
else:
    cD = login('coachd'); links = j(cD.get(B + '/api/coach/athletes'))['links']
    chk('persistencia apos restart: vinculos iguais', sorted([l['id'], l['status']] for l in links) == load('s3'), len(links))
    chk('login do aluno persistido', uid(login('aluno3b')) is not None)
    chk('aluno excluido nao entra mais', login('aluno2b').get(B + '/api/me').status_code in (401, 403, 404))
    summary('3_concurrency_delete(after)')
