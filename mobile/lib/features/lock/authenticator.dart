import 'package:local_auth/local_auth.dart';

/// Autentificarea locală a telefonului (amprentă, față sau PIN/model). Abstracție, ca testele să
/// nu depindă de platformă.
abstract class Authenticator {
  /// Telefonul are blocare de ecran sau biometrie configurată.
  Future<bool> isSupported();

  /// Cere utilizatorului să se autentifice; `false` dacă a renunțat sau a eșuat.
  Future<bool> authenticate(String reason);
}

class LocalAuthenticator implements Authenticator {
  LocalAuthenticator([LocalAuthentication? auth])
    : _auth = auth ?? LocalAuthentication();

  final LocalAuthentication _auth;

  @override
  Future<bool> isSupported() async {
    try {
      return await _auth.isDeviceSupported();
    } on Object {
      return false;
    }
  }

  @override
  Future<bool> authenticate(String reason) async {
    try {
      // Biometrie sau PIN/model al telefonului (nu doar biometrie), ca utilizatorul să nu rămână
      // blocat afară dacă senzorul nu funcționează.
      return await _auth.authenticate(localizedReason: reason);
    } on Object {
      return false;
    }
  }
}
