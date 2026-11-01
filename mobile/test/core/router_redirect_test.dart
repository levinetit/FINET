import 'package:finet_mobile/core/network/api_error.dart';
import 'package:finet_mobile/core/router.dart';
import 'package:finet_mobile/features/auth/models.dart';
import 'package:finet_mobile/features/auth/session.dart';
import 'package:flutter_test/flutter_test.dart';

const _profile = Profile(
  user: UserInfo(id: 'u', email: 'a@b.ro', name: 'A'),
);
const _unavailable = SessionUnavailable(
  ApiError(kind: ApiErrorKind.network, message: 'x'),
);

String? go(String location, SessionState session, {bool intro = true}) =>
    redirectFor(location: location, session: session, introSeen: intro);

void main() {
  test('prima pornire: întâi informarea, indiferent de sesiune', () {
    for (final s in [
      const SessionLoading(),
      const SignedOut(),
      const SignedIn(_profile),
    ]) {
      expect(go('/', s, intro: false), '/intro');
      expect(go('/intro', s, intro: false), isNull);
    }
  });

  test('se verifică tokenul: splash', () {
    expect(go('/', const SessionLoading()), '/splash');
    expect(go('/splash', const SessionLoading()), isNull);
  });

  test('fără sesiune: orice duce la login', () {
    expect(go('/', const SignedOut()), '/login');
    expect(go('/profile', const SignedOut()), '/login');
    expect(go('/login', const SignedOut()), isNull);
  });

  test('server indisponibil: ecranul de reîncercare', () {
    expect(go('/', _unavailable), '/unavailable');
    expect(go('/unavailable', _unavailable), isNull);
  });

  test('cu sesiune: porțile duc la Acasă, restul rămân', () {
    const s = SignedIn(_profile);
    for (final gate in ['/login', '/splash', '/intro', '/unavailable']) {
      expect(go(gate, s), '/');
    }
    for (final page in ['/', '/transactions', '/profile', '/settings']) {
      expect(go(page, s), isNull);
    }
  });

  test(
    'versiune sub minimul serverului: totul duce la ecranul de actualizare',
    () {
      String? update(String location) => redirectFor(
        location: location,
        session: const SignedIn(_profile),
        introSeen: true,
        updateRequired: true,
      );
      expect(update('/'), '/update-required');
      expect(update('/transactions'), '/update-required');
      expect(update('/update-required'), isNull);
      // Fără sesiune, loginul rămâne posibil (nu trimite cereri financiare).
      expect(
        redirectFor(
          location: '/login',
          session: const SignedOut(),
          introSeen: true,
          updateRequired: true,
        ),
        isNull,
      );
    },
  );
}
