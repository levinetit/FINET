import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/tokens.dart';
import '../../core/widgets/logo.dart';
import '../settings/settings_controller.dart';
import 'authenticator.dart';

final authenticatorProvider = Provider<Authenticator>(
  (ref) => LocalAuthenticator(),
);

/// Ceasul, înlocuibil în teste (timpul petrecut în fundal).
final clockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// Cât timp poate sta aplicația în fundal înainte să ceară din nou deblocarea.
const Duration lockTimeout = Duration(minutes: 2);

/// Dacă aplicația e blocată acum. Pornește blocată dacă blocarea e activată.
final lockedProvider = NotifierProvider<LockController, bool>(
  LockController.new,
);

class LockController extends Notifier<bool> {
  @override
  bool build() => ref.read(settingsProvider).appLock;

  void lock() {
    if (ref.read(settingsProvider).appLock) state = true;
  }

  void unlockedByUser() => state = false;

  /// Cere deblocarea; întoarce `true` dacă a reușit.
  Future<bool> unlock() async {
    final ok = await ref
        .read(authenticatorProvider)
        .authenticate('Deblochează FINET');
    if (ok) state = false;
    return ok;
  }
}

/// Înfășoară aplicația: blochează la pornire și după [lockTimeout] în fundal, dacă blocarea e
/// activată. Conținutul rămâne în arbore (se păstrează starea), dar nu se desenează și nu e
/// expus accesibilității cât timp e blocat.
class LockGate extends ConsumerStatefulWidget {
  const LockGate({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<LockGate> createState() => _LockGateState();
}

class _LockGateState extends ConsumerState<LockGate>
    with WidgetsBindingObserver {
  DateTime? _pausedAt;
  bool _prompting = false;

  DateTime _now() => ref.read(clockProvider)();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (ref.read(lockedProvider)) _prompt();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_prompting) return;
    switch (state) {
      case AppLifecycleState.paused:
        _pausedAt ??= _now();
      case AppLifecycleState.resumed:
        final since = _pausedAt;
        _pausedAt = null;
        if (since != null && _now().difference(since) >= lockTimeout) {
          ref.read(lockedProvider.notifier).lock();
          if (ref.read(lockedProvider)) _prompt();
        }
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
      case AppLifecycleState.detached:
        break;
    }
  }

  Future<void> _prompt() async {
    if (_prompting) return;
    _prompting = true;
    try {
      await ref.read(lockedProvider.notifier).unlock();
    } finally {
      _prompting = false;
      _pausedAt = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final locked = ref.watch(lockedProvider);
    return Stack(
      children: [
        Offstage(offstage: locked, child: widget.child),
        if (locked) _LockScreen(onUnlock: _prompt),
      ],
    );
  }
}

class _LockScreen extends StatelessWidget {
  const _LockScreen({required this.onUnlock});

  final VoidCallback onUnlock;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Material(
      color: context.finet.bg,
      child: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const FinetLogo(height: 40),
              const SizedBox(height: 24),
              Text('Aplicația este blocată', style: text.titleMedium),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: onUnlock,
                icon: const Icon(Icons.lock_open),
                label: const Text('Deblochează'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
