package com.mimvista.hastebin.server;

import java.io.IOException;

public class HasteInfo implements Cloneable {
	private String name;
	private String key;
	private String mimetype;
	private String encoding;
	private String syntax;
	private long size;
	private long time;
	
	private HasteInfo() {
		// prevent instantiation, use HasteInfo.builder()
	}
	
	public String getName() {
		return name;
	}
	public String getKey() {
		return key;
	}
	public String getMimetype() {
		return mimetype;
	}
	public String getEncoding() {
		return encoding;
	}
	public String getSyntax() {
		return syntax;
	}
	public long getSize() {
		return size;
	}
	public long getTime() {
		return time;
	}
	
	public String toJson() {
		try {
			return HasteUtils.mapper().writeValueAsString(this);
		} catch (IOException ex) {
			throw new RuntimeException(ex);
		}
	}
	
	public static Builder builder() {
		return new Builder();
	}
	public static Builder builder(HasteInfo info) {
		return new Builder(info);
	}
	
	public static class Builder {
		private HasteInfo info;
		
		public Builder() {
			this.info = new HasteInfo();
			this.info.time = System.currentTimeMillis();
		}
		public Builder(HasteInfo info) {
			try {
				this.info = (HasteInfo)info.clone();
			} catch (CloneNotSupportedException e) {
				// Can't happen, HasteInfo is Cloneable
			}
		}
		
		/**
		 * This is only here so you can get read access to the values you've already
		 * set in the builder.  When you're done setting values you should call build(),
		 * which will return you a cloned HasteInfo that won't be affected by future
		 * set calls on this builder.
		 */
		public HasteInfo info() {
			return this.info;
		}
		
		public HasteInfo build() {
			try {
				return (HasteInfo)this.info.clone();
			} catch (CloneNotSupportedException e) {
				// Can't happen, HasteInfo is Cloneable
				return null;
			}
		}
		
		public Builder setName(String name) {
			this.info.name = name;
			return this;
		}
		public Builder setKey(String key) {
			this.info.key = key;
			return this;
		}
		public Builder setMimetype(String mimetype) {
			this.info.mimetype = mimetype;
			return this;
		}
		public Builder setEncoding(String encoding) {
			this.info.encoding = encoding;
			return this;
		}
		public Builder setSyntax(String syntax) {
			this.info.syntax = syntax;
			return this;
		}
		public Builder setSize(long size) {
			this.info.size = size;
			return this;
		}
		public Builder setTime(long time) {
			this.info.time = time;
			return this;
		}
	}
	
	public static HasteInfo fromJson(String json) {
		try {
			return HasteUtils.mapper().readValue(json, HasteInfo.class);
		} catch (IOException ex) {
			throw new RuntimeException(ex);
		}
	}
}
