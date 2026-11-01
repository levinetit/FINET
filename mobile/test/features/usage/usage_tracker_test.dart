import 'package:dio/dio.dart';
import 'package:finet_mobile/core/network/api_error.dart';
import 'package:finet_mobile/features/usage/usage_tracker.dart';
import 'package:flutter_test/flutter_test.dart';

ApiError apiError(int status) => ApiError(
  kind: status == 403 ? ApiErrorKind.forbidden : ApiErrorKind.client,
  message: 'x',
  status: status,
);

void main() {
  late List<List<Map<String, Object>>> sent;
  late Object? failure;

  UsageTracker tracker({
    bool enabled = true,
    bool signedIn = true,
    int max = 300,
  }) => UsageTracker(
    enabled: enabled,
    signedIn: signedIn,
    maxQueue: max,
    now: () => DateTime.utc(2026, 11, 1, 10),
    send: (events) async {
      if (failure != null) throw failure!;
      sent.add(events);
    },
  );

  setUp(() {
    sent = [];
    failure = null;
  });

  test('dezactivat: nu se înregistrează nimic', () {
    final t = tracker(enabled: false)..track(UsageEvents.appOpen);
    expect(t.pending, 0);
  });

  test('fără sesiune nu se înregistrează nimic', () {
    final t = tracker(signedIn: false)..track(UsageEvents.appOpen);
    expect(t.pending, 0);
  });

  test('evenimentul are doar câmpurile permise, momentul în UTC', () {
    final t = tracker()
      ..track(UsageEvents.appOpen)
      ..screen(UsageScreens.reports)
      ..error(apiError(409));
    final json = [for (final e in t.queued) e.toJson()];
    expect(json[0], {
      'name': 'app_open',
      'occurredAt': '2026-11-01T10:00:00.000Z',
    });
    expect(json[1]['screen'], 'reports');
    expect(json[2]['errorCode'], 'conflict');
    const allowed = {'name', 'screen', 'errorCode', 'occurredAt'};
    for (final e in json) {
      expect(allowed, containsAll(e.keys));
    }
  });

  test('trimite în loturi de cel mult 20 și golește coada', () async {
    final t = tracker();
    for (var i = 0; i < 45; i++) {
      t.track(UsageEvents.appOpen);
    }
    await t.flush();
    expect(sent.map((b) => b.length), [20, 20, 5]);
    expect(t.pending, 0);
  });

  test(
    'eroare de rețea: evenimentele rămân pentru următoarea încercare',
    () async {
      final t = tracker()..track(UsageEvents.appOpen);
      failure = const ApiError(kind: ApiErrorKind.network, message: 'x');
      await t.flush();
      expect(t.pending, 1);
      failure = null;
      await t.flush();
      expect(t.pending, 0);
      expect(sent, hasLength(1));
    },
  );

  test('403 (fără consimțământ) sau 400: lotul se aruncă, nu se repetă la nesfârșit', () async {
    for (final status in [400, 403]) {
      final t = tracker()..track(UsageEvents.appOpen);
      failure = apiError(status);
      await t.flush();
      expect(t.pending, 0, reason: '$status');
    }
  });

  test('coada e plafonată: cele mai vechi se pierd', () {
    final t = tracker(max: 3);
    for (final s in ['dashboard', 'transactions', 'scan', 'reports']) {
      t.screen(s);
    }
    expect(t.queued.map((e) => e.screen), ['transactions', 'scan', 'reports']);
  });

  test('clear păstrează doar session_expired când se cere', () {
    final t = tracker()
      ..track(UsageEvents.appOpen)
      ..track(UsageEvents.sessionExpired)
      ..clear(keepSessionExpired: true);
    expect(t.queued.map((e) => e.name), [UsageEvents.sessionExpired]);
    t.clear();
    expect(t.pending, 0);
  });

  test('o golire în timpul trimiterii nu strică coada', () async {
    late UsageTracker t;
    t = UsageTracker(
      enabled: true,
      signedIn: true,
      send: (events) async {
        t.clear();
        t.track(UsageEvents.appOpen);
      },
    )..track(UsageEvents.login);
    await t.flush();
    // Lotul trimis a plecat; evenimentul nou, adăugat între timp, nu se pierde.
    expect(t.pending, 1);
  });

  test('toate numele și ecranele folosite există în contractul serverului', () {
    const serverNames = {
      'app_open',
      'login',
      'logout',
      'session_expired',
      'screen_view',
      'error_shown',
    };
    const serverScreens = {
      'login',
      'onboarding',
      'dashboard',
      'transactions',
      'scan',
      'reports',
      'settings',
      'profile',
    };
    expect({
      UsageEvents.appOpen,
      UsageEvents.login,
      UsageEvents.logout,
      UsageEvents.sessionExpired,
      UsageEvents.screenView,
      UsageEvents.errorShown,
    }, serverNames);
    expect({
      UsageScreens.login,
      UsageScreens.onboarding,
      UsageScreens.dashboard,
      UsageScreens.transactions,
      UsageScreens.scan,
      UsageScreens.reports,
      UsageScreens.settings,
      UsageScreens.profile,
    }, serverScreens);
  });

  test('codurile de eroare sunt cele acceptate de server', () {
    const accepted = {
      'network_timeout',
      'network_unavailable',
      'access_required',
      'server_error',
      'unauthenticated',
      'forbidden',
      'not_found',
      'validation_failed',
      'conflict',
      'rate_limited',
      'update_required',
      'upload_failed',
      'unknown',
    };
    final errors = [
      for (final kind in ApiErrorKind.values)
        for (final status in [400, 404, 409, 418, 500])
          ApiError(kind: kind, message: 'x', status: status),
    ];
    for (final e in errors) {
      expect(accepted, contains(e.analyticsCode), reason: '$e');
    }
    expect(DioExceptionType.values, isNotEmpty);
  });
}
