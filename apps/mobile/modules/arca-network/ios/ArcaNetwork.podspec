Pod::Spec.new do |s|
  s.name = 'ArcaNetwork'
  s.version = '0.4.2'
  s.summary = 'Arca private network checks'
  s.description = s.summary
  s.license = 'MIT'
  s.author = 'Arca'
  s.homepage = 'https://github.com/satoshi-ltd/arca'
  s.platforms = { :ios => '15.1' }
  s.source = { :git => 'https://github.com/satoshi-ltd/arca' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
