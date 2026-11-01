import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/widgets/logo.dart';
import '../../core/widgets/states.dart';
import 'session.dart';

/// Ecran de așteptare cât se verifică tokenul păstrat.
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            FinetLogo(height: 44),
            SizedBox(height: 24),
            SizedBox(
              height: 24,
              width: 24,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ],
        ),
      ),
    );
  }
}

/// Tokenul există, dar serverul nu răspunde: reîncercare sau deconectare. Nu cerem parola din
/// nou, pentru că sesiunea poate fi încă validă.
class SessionUnavailableScreen extends ConsumerWidget {
  const SessionUnavailableScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(sessionProvider);
    final message = state is SessionUnavailable
        ? state.error.message
        : 'Nu te poți conecta la FINET.';
    return Scaffold(
      body: SafeArea(
        child: ErrorState(
          message: message,
          onRetry: () => ref.read(sessionProvider.notifier).restore(),
          secondary: TextButton(
            onPressed: () => ref.read(sessionProvider.notifier).logout(),
            child: const Text('Deconectează-mă'),
          ),
        ),
      ),
    );
  }
}
