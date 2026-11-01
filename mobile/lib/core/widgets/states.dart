import 'package:flutter/material.dart';

import '../theme/tokens.dart';

/// Stare de încărcare, distinctă de „gol” și „eroare” (promptul §9).
class LoadingState extends StatelessWidget {
  const LoadingState({super.key, this.label = 'Se încarcă…'});
  final String label;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Semantics(label: label, child: const CircularProgressIndicator()),
    );
  }
}

/// Stare goală: explică ce lipsește și ce se poate face.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.title, this.message, this.action});
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) => _Centered(
    icon: Icons.inbox_outlined,
    title: title,
    message: message,
    action: action,
  );
}

/// Stare de eroare, cu acțiune de reîncercare.
class ErrorState extends StatelessWidget {
  const ErrorState({
    super.key,
    required this.message,
    this.onRetry,
    this.secondary,
  });
  final String message;
  final VoidCallback? onRetry;

  /// Acțiune în plus sub butonul de reîncercare (de exemplu „Deconectează-mă”).
  final Widget? secondary;

  @override
  Widget build(BuildContext context) => _Centered(
    icon: Icons.error_outline,
    iconColor: context.finet.bad,
    title: 'Ceva nu a mers',
    message: message,
    action: onRetry == null
        ? secondary
        : Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              OutlinedButton(
                onPressed: onRetry,
                child: const Text('Încearcă din nou'),
              ),
              ?secondary,
            ],
          ),
  );
}

class _Centered extends StatelessWidget {
  const _Centered({
    required this.icon,
    required this.title,
    this.iconColor,
    this.message,
    this.action,
  });

  final IconData icon;
  final Color? iconColor;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 40, color: iconColor ?? context.finet.muted),
            const SizedBox(height: 12),
            Text(title, style: text.titleMedium, textAlign: TextAlign.center),
            if (message != null) ...[
              const SizedBox(height: 6),
              Text(
                message!,
                style: text.bodyMedium?.copyWith(color: context.finet.muted),
                textAlign: TextAlign.center,
              ),
            ],
            if (action != null) ...[const SizedBox(height: 16), action!],
          ],
        ),
      ),
    );
  }
}
