import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../network/api_error.dart';
import 'states.dart';

/// Afișează o valoare asincronă cu cele trei stări distincte din promptul Android §9:
/// încărcare, eroare (cu reîncercare) și date. „Gol” îl decide ecranul, din date.
class AsyncView<T> extends StatelessWidget {
  const AsyncView({
    super.key,
    required this.value,
    required this.onRetry,
    required this.data,
  });

  final AsyncValue<T> value;
  final VoidCallback onRetry;
  final Widget Function(T data) data;

  @override
  Widget build(BuildContext context) {
    return value.when(
      skipLoadingOnRefresh: false,
      loading: () => const LoadingState(),
      error: (e, _) => ErrorState(message: errorMessage(e), onRetry: onRetry),
      data: data,
    );
  }
}

/// Mesajul pentru utilizator dintr-o eroare oarecare.
String errorMessage(Object error) =>
    error is ApiError ? error.message : 'A apărut o eroare. Încearcă din nou.';
