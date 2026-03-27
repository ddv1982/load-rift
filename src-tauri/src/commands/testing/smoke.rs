use std::collections::BTreeMap;
use std::io::Read;
use std::time::Instant;

use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};

use crate::importing::ResolvedRuntimeRequest;
use crate::models::{SmokeTestResponse, SmokeTestResult};

const BODY_PREVIEW_LIMIT_BYTES: usize = 16 * 1024;
const REQUEST_TIMEOUT_SECS: u64 = 30;

pub(super) fn run_smoke_test(
    requests: Vec<ResolvedRuntimeRequest>,
) -> Result<SmokeTestResponse, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("Failed to prepare the smoke test client: {error}"))?;

    let responses = requests
        .into_iter()
        .map(|request| execute_request(&client, request))
        .collect();

    Ok(SmokeTestResponse { responses })
}

fn execute_request(client: &Client, request: ResolvedRuntimeRequest) -> SmokeTestResult {
    let started_at = Instant::now();
    let method = request.method.clone();
    let url = request.url.clone();

    let request_builder = match reqwest::Method::from_bytes(request.method.as_bytes()) {
        Ok(parsed_method) => client.request(parsed_method, &request.url),
        Err(error) => {
            return SmokeTestResult {
                request_id: request.id,
                request_name: request.name,
                method,
                url,
                status_code: None,
                duration_ms: started_at.elapsed().as_millis() as u64,
                ok: false,
                content_type: None,
                response_headers: BTreeMap::new(),
                body_preview: None,
                error_message: Some(format!("Unsupported HTTP method: {error}")),
            };
        }
    };

    let request_builder = match apply_headers(request_builder, &request.headers) {
        Ok(builder) => builder,
        Err(error) => {
            return SmokeTestResult {
                request_id: request.id,
                request_name: request.name,
                method,
                url,
                status_code: None,
                duration_ms: started_at.elapsed().as_millis() as u64,
                ok: false,
                content_type: None,
                response_headers: BTreeMap::new(),
                body_preview: None,
                error_message: Some(error),
            };
        }
    };

    let request_builder = if let Some(body) = request.body.clone() {
        request_builder.body(body)
    } else {
        request_builder
    };

    match request_builder.send() {
        Ok(response) => {
            let duration_ms = started_at.elapsed().as_millis() as u64;
            let status_code = response.status().as_u16();
            let headers = collect_headers(response.headers());
            let content_type = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned);
            let body_preview = read_body_preview(response).ok().flatten();

            SmokeTestResult {
                request_id: request.id,
                request_name: request.name,
                method,
                url,
                status_code: Some(status_code),
                duration_ms,
                ok: (200..400).contains(&status_code),
                content_type,
                response_headers: headers,
                body_preview,
                error_message: None,
            }
        }
        Err(error) => SmokeTestResult {
            request_id: request.id,
            request_name: request.name,
            method,
            url,
            status_code: None,
            duration_ms: started_at.elapsed().as_millis() as u64,
            ok: false,
            content_type: None,
            response_headers: BTreeMap::new(),
            body_preview: None,
            error_message: Some(error.to_string()),
        },
    }
}

fn read_body_preview(mut response: reqwest::blocking::Response) -> Result<Option<String>, String> {
    read_body_preview_from_reader(&mut response)
}

fn read_body_preview_from_reader<R: Read>(reader: R) -> Result<Option<String>, String> {
    let mut preview_bytes = Vec::with_capacity(BODY_PREVIEW_LIMIT_BYTES.saturating_add(1));
    reader
        .take(BODY_PREVIEW_LIMIT_BYTES.saturating_add(1) as u64)
        .read_to_end(&mut preview_bytes)
        .map_err(|error| format!("Failed to read the smoke test response body: {error}"))?;

    if preview_bytes.is_empty() {
        return Ok(None);
    }

    Ok(Some(truncate_preview(
        String::from_utf8_lossy(&preview_bytes).into_owned(),
    )))
}

fn apply_headers(
    request_builder: reqwest::blocking::RequestBuilder,
    headers: &BTreeMap<String, String>,
) -> Result<reqwest::blocking::RequestBuilder, String> {
    let mut header_map = HeaderMap::new();

    for (key, value) in headers {
        let name = HeaderName::try_from(key.as_str())
            .map_err(|error| format!("Invalid header name {:?}: {error}", key))?;
        let header_value = HeaderValue::try_from(value.as_str())
            .map_err(|error| format!("Invalid header value for {:?}: {error}", key))?;
        header_map.insert(name, header_value);
    }

    Ok(request_builder.headers(header_map))
}

fn collect_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    headers
        .iter()
        .filter_map(|(key, value)| {
            value
                .to_str()
                .ok()
                .map(|resolved| (key.as_str().to_string(), resolved.to_string()))
        })
        .collect()
}

fn truncate_preview(value: String) -> String {
    if value.len() <= BODY_PREVIEW_LIMIT_BYTES {
        return value;
    }

    let mut truncated = value
        .chars()
        .scan(0usize, |byte_count, character| {
            let width = character.len_utf8();
            if *byte_count + width > BODY_PREVIEW_LIMIT_BYTES {
                None
            } else {
                *byte_count += width;
                Some(character)
            }
        })
        .collect::<String>();
    truncated.push_str("\n\n...[truncated]");
    truncated
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::{Cursor, Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::{
        read_body_preview_from_reader, run_smoke_test, truncate_preview, BODY_PREVIEW_LIMIT_BYTES,
    };
    use crate::importing::ResolvedRuntimeRequest;

    #[test]
    fn truncate_preview_limits_large_payloads() {
        let large = "a".repeat(20_000);
        let preview = truncate_preview(large);

        assert!(preview.len() < 17_000);
        assert!(preview.ends_with("...[truncated]"));
    }

    #[test]
    fn read_body_preview_only_keeps_the_capped_prefix() {
        let large = "a".repeat(20_000);
        let preview = read_body_preview_from_reader(Cursor::new(large.as_bytes()))
            .expect("preview should be readable")
            .expect("preview should be present");

        assert!(preview.len() < 17_000);
        assert!(preview.ends_with("...[truncated]"));
        assert!(preview.starts_with(&"a".repeat(BODY_PREVIEW_LIMIT_BYTES)));
    }

    #[test]
    fn run_smoke_test_captures_response_preview_headers_and_status() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let address = listener
            .local_addr()
            .expect("listener should expose address");

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("request should arrive");
            let mut buffer = [0u8; 2048];
            let _ = stream.read(&mut buffer);
            let response = concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: text/xml; charset=utf-8\r\n",
                "X-Smoke: yes\r\n",
                "Content-Length: 23\r\n",
                "\r\n",
                "<Envelope>ok</Envelope>"
            );
            stream
                .write_all(response.as_bytes())
                .expect("response should write");
        });

        let response = run_smoke_test(vec![ResolvedRuntimeRequest {
            id: "request-1".to_string(),
            name: "SOAP login".to_string(),
            method: "POST".to_string(),
            url: format!("http://{address}/soap"),
            headers: BTreeMap::from([(
                "Content-Type".to_string(),
                "text/xml; charset=utf-8".to_string(),
            )]),
            body: Some("<Envelope>ping</Envelope>".to_string()),
        }])
        .expect("smoke test should complete");

        server.join().expect("server should exit cleanly");

        let first = response.responses.first().expect("response should exist");
        assert_eq!(first.status_code, Some(200));
        assert!(first.ok);
        assert_eq!(
            first.content_type.as_deref(),
            Some("text/xml; charset=utf-8")
        );
        assert_eq!(
            first.response_headers.get("x-smoke").map(String::as_str),
            Some("yes")
        );
        assert_eq!(
            first.body_preview.as_deref(),
            Some("<Envelope>ok</Envelope>")
        );
        assert!(first.error_message.is_none());
    }
}
