using System.Net.Http.Json;
using System.Security.Cryptography.X509Certificates;

namespace Tryggsignal.EdgeConnector;

/// <summary>
/// Masterplan 63/64: the connector only ever dials out. No inbound internet port
/// into the municipal network is required, TLS is mandatory and mTLS is supported.
/// Credentials are read from the Windows credential store or user secrets, never
/// from source, and are never written to a log.
/// </summary>
public sealed class OutboundChannel : IDisposable
{
    private readonly HttpClient _http;

    public OutboundChannel(EdgeConnectorOptions options)
    {
        var handler = new HttpClientHandler
        {
            // The platform certificate chain is validated normally; pinning is
            // configured by the municipality where their policy requires it.
            SslProtocols = System.Security.Authentication.SslProtocols.Tls12
                | System.Security.Authentication.SslProtocols.Tls13,
        };

        if (!string.IsNullOrWhiteSpace(options.ClientCertificateThumbprint))
        {
            handler.ClientCertificates.Add(LoadClientCertificate(options.ClientCertificateThumbprint));
        }

        _http = new HttpClient(handler)
        {
            BaseAddress = new Uri(options.PlatformBaseUrl),
            Timeout = TimeSpan.FromSeconds(60),
        };
    }

    private static X509Certificate2 LoadClientCertificate(string thumbprint)
    {
        using var store = new X509Store(StoreName.My, StoreLocation.LocalMachine);
        store.Open(OpenFlags.ReadOnly);
        var found = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: true);
        if (found.Count == 0)
        {
            throw new InvalidOperationException(
                "The configured client certificate was not found in LocalMachine\\My. " +
                "Install it and grant the service account read access to its private key.");
        }
        return found[0];
    }

    /// <summary>
    /// Masterplan 66/67: every delivery carries an idempotency key, so an
    /// at-least-once retry can never create a duplicate case on the platform side.
    /// </summary>
    public async Task<DeliveryOutcome> DeliverAsync(
        IntegrationEnvelope envelope,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/integration/inbound")
        {
            Content = JsonContent.Create(envelope),
        };
        request.Headers.Add("Idempotency-Key", envelope.IdempotencyKey);
        request.Headers.Add("X-Correlation-Id", envelope.CorrelationId);

        using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);

        return response.StatusCode switch
        {
            System.Net.HttpStatusCode.Conflict => DeliveryOutcome.AlreadyDelivered,
            System.Net.HttpStatusCode.OK or System.Net.HttpStatusCode.Accepted
                or System.Net.HttpStatusCode.Created => DeliveryOutcome.Delivered,
            System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden
                => DeliveryOutcome.Unauthorized,
            _ when (int)response.StatusCode >= 500 => DeliveryOutcome.Retryable,
            _ => DeliveryOutcome.Rejected,
        };
    }

    public void Dispose() => _http.Dispose();
}

public enum DeliveryOutcome
{
    Delivered,
    AlreadyDelivered,
    Retryable,
    Unauthorized,
    Rejected,
}

public sealed record IntegrationEnvelope(
    string JobId,
    string Type,
    string TenantContext,
    string? AuthorityContext,
    string CorrelationId,
    string IdempotencyKey,
    object Payload,
    int Attempt,
    DateTimeOffset CreatedAt);

public sealed class EdgeConnectorOptions
{
    public required string PlatformBaseUrl { get; init; }
    public string? ClientCertificateThumbprint { get; init; }
    /// <summary>Reference into the credential store, never a credential value.</summary>
    public required string CredentialReference { get; init; }
    public int MaxAttempts { get; init; } = 8;
    public TimeSpan PollInterval { get; init; } = TimeSpan.FromSeconds(30);
}
