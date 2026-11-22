require "webrick/https"
require "open3"
require "base64"
require "socket"

fixture, port_file, git_server_dir = ARGV
server = WEBrick::HTTPServer.new(
  BindAddress: "127.0.0.1", Port: 0, SSLEnable: true,
  SSLCertificate: OpenSSL::X509::Certificate.new(File.read("#{fixture}/cert.pem")),
  SSLPrivateKey: OpenSSL::PKey.read(File.read("#{fixture}/key.pem")),
  Logger: WEBrick::Log.new($stderr, WEBrick::Log::WARN), AccessLog: []
)
server.mount_proc("/") do |req, res|
  expected = "Basic " + Base64.strict_encode64("aleph-fixture:loopback-only-fixture-token")
  unless req["authorization"] == expected
    res.status = 401
    res["www-authenticate"] = 'Basic realm="Aleph loopback fixture"'
    next
  end
  body = req.body || ""
  out, err, status = Open3.capture3({
    "GIT_PROJECT_ROOT" => fixture,
    "GIT_HTTP_EXPORT_ALL" => "1",
    "GIT_CONFIG_GLOBAL" => "/dev/null",
    "GIT_CONFIG_NOSYSTEM" => "1",
    "REMOTE_USER" => "aleph-fixture",
    "PATH_INFO" => req.path,
    "REQUEST_METHOD" => req.request_method,
    "CONTENT_TYPE" => req["content-type"] || "",
    "CONTENT_LENGTH" => body.bytesize.to_s,
    "QUERY_STRING" => req.query_string || ""
  }, File.join(git_server_dir, "git-http-backend"),
    stdin_data: body, binmode: true)
  unless status.success?
    warn err
    res.status = 500
    next
  end
  headers, response = out.split("\r\n\r\n", 2)
  headers.split("\r\n").each do |line|
    key, value = line.split(": ", 2)
    if key.downcase == "status"
      res.status = value.split.first.to_i
    else
      res[key] = value
    end
  end
  res.body = response
end
trap("TERM") { server.shutdown }
File.write(port_file, server.listeners.first.addr[1].to_s)
server.start
