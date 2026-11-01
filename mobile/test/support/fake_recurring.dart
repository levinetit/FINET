import 'package:dio/dio.dart';

import 'fake_server.dart';

/// Rutele plăților recurente pe [FakeServer]: reguli, pauză/reluare, generare și propuneri.
class FakeRecurring {
  FakeRecurring(this.server) {
    server.on('GET /api/v1/recurring', (o) {
      if (!server.authorized(o)) return _unauth();
      return jsonBody({'data': rules, 'counts': _counts()});
    });
    server.on('POST /api/v1/recurring/{id}/pause', (o) => _toggle(o, true));
    server.on('POST /api/v1/recurring/{id}/resume', (o) => _toggle(o, false));
    server.on('POST /api/v1/recurring/generate', (o) {
      if (!server.authorized(o)) return _unauth();
      final key = o.headers['Idempotency-Key'] as String?;
      if (key == null) {
        return finetError(400, 'invalid_request', 'Cheie lipsă');
      }
      generateKeys.add(key);
      // Aceeași cheie = aceeași generare: serverul nu scrie a doua oară.
      if (!_generated.add(key)) {
        return jsonBody(_result(0));
      }
      generatedTransactions += 2;
      return jsonBody(_result(2));
    });
    server.on('GET /api/v1/recurring/suggestions', (o) {
      if (!server.authorized(o)) return _unauth();
      return jsonBody({'data': suggestions});
    });
    server.on('POST /api/v1/recurring/suggestions/{id}/accept', (o) {
      if (!server.authorized(o)) return _unauth();
      acceptKeys.add(o.headers['Idempotency-Key'] as String? ?? '');
      accepted.add(o.uri.pathSegments[4]);
      suggestions.clear();
      return jsonBody({'data': rules.first}, status: 201);
    });
    server.on('POST /api/v1/recurring/suggestions/{id}/dismiss', (o) {
      if (!server.authorized(o)) return _unauth();
      dismissed.add(o.uri.pathSegments[4]);
      suggestions.clear();
      return emptyBody(204);
    });
  }

  final FakeServer server;

  static const ruleRent = 'd0000000-0000-4000-8000-000000000001';
  static const ruleGym = 'd0000000-0000-4000-8000-000000000002';
  static const ruleOld = 'd0000000-0000-4000-8000-000000000003';

  final List<String> generateKeys = [];
  final List<String> acceptKeys = [];
  final List<String> accepted = [];
  final List<String> dismissed = [];
  int generatedTransactions = 0;
  final Set<String> _generated = {};

  late final List<Map<String, Object?>> rules = [
    _rule(
      ruleRent,
      'Chirie',
      'expense',
      180000,
      'active',
      due: true,
      next: '2026-11-05',
    ),
    _rule(
      ruleGym,
      'Sală',
      'expense',
      15000,
      'paused',
      next: '2026-11-10',
      interval: 2,
    ),
    _rule(
      ruleOld,
      'Rată veche',
      'expense',
      99900,
      'completed',
      next: '2026-10-01',
    ),
  ];

  final List<Map<String, Object?>> suggestions = [
    {
      'signature': 'sig/abc 1',
      'accountId': FakeServer.accCurrent,
      'accountName': 'Cont curent',
      'type': 'expense',
      'currency': 'RON',
      'description': 'Abonament video',
      'merchant': 'StreamCo',
      'categoryId': null,
      'frequency': 'monthly',
      'amountMinor': 4599,
      'occurrences': 4,
      'lastOn': '2026-10-12',
      'nextOn': '2026-11-12',
    },
  ];

  Map<String, Object?> _rule(
    String id,
    String description,
    String type,
    int amount,
    String status, {
    required String next,
    bool due = false,
    int interval = 1,
  }) => {
    'id': id,
    'accountId': FakeServer.accCurrent,
    'categoryId': null,
    'type': type,
    'amountMinor': amount,
    'currency': 'RON',
    'description': description,
    'merchant': null,
    'frequency': 'monthly',
    'interval': interval,
    'dayOfMonth': 5,
    'startOn': '2026-01-05',
    'nextRunOn': next,
    'endOn': null,
    'maxOccurrences': null,
    'occurrencesCount': 3,
    'status': status,
    'due': due,
    'lastErrorCode': null,
    'createdAt': '2026-01-01T00:00:00.000Z',
    'updatedAt': '2026-01-01T00:00:00.000Z',
  };

  Map<String, Object?> _counts() => {
    'active': rules.where((r) => r['status'] == 'active').length,
    'due': rules.where((r) => r['due'] == true).length,
    'total': rules.length,
  };

  Map<String, Object?> _result(int generated) => {
    'data': {
      'today': '2026-11-01',
      'rules': 1,
      'generated': generated,
      'failed': 0,
      'skipped': 0,
    },
  };

  ResponseBody _toggle(RequestOptions o, bool pause) {
    if (!server.authorized(o)) return _unauth();
    final id = o.uri.pathSegments[3];
    final rule = rules.firstWhere((r) => r['id'] == id);
    if (rule['status'] == 'completed') {
      return finetError(
        409,
        'recurring_completed',
        'Regula este încheiată și nu poate fi modificată.',
      );
    }
    rule['status'] = pause ? 'paused' : 'active';
    return jsonBody({'data': rule});
  }

  ResponseBody _unauth() =>
      finetError(401, 'unauthenticated', 'Sesiune invalidă');
}
